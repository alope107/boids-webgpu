async function main() {
    // Tunables!
    const sightRadius = .04;
    const wall = 1.05;

    // Ensure that buckets are smaller than the sightRadius
    // (field spans from -wall to wall (length of 2*wall))
    const fieldSideLength = 2 * wall;
    const bucketRows = Math.max(Math.ceil(fieldSideLength/sightRadius)-1, 1);
    const bucketCols = Math.max(Math.ceil(fieldSideLength/sightRadius)-1, 1);

    // Check webGPU support and get device
    const adapter = await navigator.gpu?.requestAdapter();
    const device = await adapter?.requestDevice();
    if(!device) {
        console.error("No WebGPU compatible device found");
        return;
    }

    // get HTML element to render to
    const canvas = document.getElementById("renderTarget");

    // Write in the way the user agent says the canvas likes
    const ctx = canvas.getContext("webgpu");
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device,
        format: presentationFormat
    });

    // load shaders from wgsl files
    const [computeCodeResp, renderCodeResp] = await Promise.all([
        fetch("./boidsCompute.wgsl"),
        fetch("./boidsRender.wgsl")
    ]);
    if(!computeCodeResp.ok || !renderCodeResp.ok) {
        console.error("failed to load shader code");
        return;
    }
    const [computeShaderCode, renderShaderCode] = await Promise.all([
        computeCodeResp.text(),
        renderCodeResp.text()
    ]);

    const computeModule = device.createShaderModule({
        label: "compute boid values shader",
        code: computeShaderCode
    });
    const renderModule = device.createShaderModule({
        label: "render boids shader",
        code: renderShaderCode
    });

    // Our pipelines define how our bind groups are laid out
    // and which shader functions should be called
    const bucketCountsPipeline = device.createComputePipeline({
        label: 'compute bucketCounts pipeline',
        // TODO: Set up bind group manually because it's shared across the different compute stages
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "countBuckets", // Counts how many boids in each bucket
            constants: { // TODO: common constants, and all
                sightRadius: sightRadius,
                wall: wall,
                bucketRows: bucketRows,
                bucketCols: bucketCols
            }
        },
    });
    const bucketOffsetsPipeline = device.createComputePipeline({
        label: 'compute bucketOffsets pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "bucketOffsets", // Calculate where in the ids array each bucket will start/end
            constants: {
                sightRadius: sightRadius,
                wall: wall,
                bucketRows: bucketRows,
                bucketCols: bucketCols
            }
        },
    });
    const bucketedIdsPipeline = device.createComputePipeline({
        label: 'compute bucketedIds pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "bucketBoids", // place boid ids into buckets
            constants: {
                sightRadius: sightRadius,
                wall: wall,
                bucketRows: bucketRows,
                bucketCols: bucketCols
            }
        },
    });
    const physicsPipeline = device.createComputePipeline({
        label: 'compute physics pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "updatePosition",
            constants: {
                sightRadius: sightRadius,
                wall: wall,
                bucketRows: bucketRows,
                bucketCols: bucketCols
            }
        },
    });
    const renderPipeline = device.createRenderPipeline({
        label: 'render boids pipeline',
        layout: 'auto', // auto should be fine, we want different buffers than the compute
        vertex: {
            entryPoint: 'boidVertex',
            module: renderModule
        },
        fragment: {
            entryPoint: 'boidFragment',
            module: renderModule,
            targets: [{ format: presentationFormat }] // interesting that we can have multiple targets...
        }
    });


// Corresponds to the uniforms typed array in the JS
// struct Uniforms {
//     mousePos : vec2f, // 8 bytes
//     time : f32 // 4 bytes
//     //pad 4 bytes
// } // total: 16 bytes (4 floats)
    const uniformFloatCount = 4;
    const uniformData = new Float32Array(uniformFloatCount);

    const uniformBuffer = device.createBuffer({
        label: "uniform buffer",
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | // We'll be using it as uniform (think globals) in the shaders
               GPUBufferUsage.COPY_DST  // We need this because we'll be copying to it from the CPU
    });

// // IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// // CHANGE IT IN THE OTHER SHADER TOO
// struct Boid {
//     position: vec2f, // 8 bytes
//     velocity: vec2f, // 8 bytes
//     color:    vec4f, // 16 bytes
// } // Total 32 bytes
    // Changing boid struct? All this needs to change!
    const boidStructSize = 32;
    const floatCount = boidStructSize / 4;
    // Gets boidCount from "count" queryParam if present, else defaults to 1000
    const boidCount = new URLSearchParams(window.location.search).get("count") || 1000;
    const boidValues = new ArrayBuffer(boidCount * boidStructSize);
    // Views can be recomputed here: https://webgpufundamentals.org/webgpu/lessons/resources/wgsl-offset-computer.html
    const boidViews = {
        position: new Float32Array(boidValues, 0),
        velocity: new Float32Array(boidValues, 8),
        color: new Float32Array(boidValues, 16),
    };
    let jsBoids = [];

    let rand = (min, max) => Math.random() * (max-min) + min; // random in range
    let randInside = () => rand(-1, 1); // random inside vertex coordinate space

    for(let i = 0; i < boidCount; i++) {
        boidViews.position.set([randInside(), randInside()], i*floatCount);
        boidViews.velocity.set([randInside()*.05, randInside()*.05], i*floatCount);
        //boidViews.color.set([Math.random(), Math.random(), Math.random(), 1.0], i*floatCount); //confetti
        boidViews.color.set([0, 0, 1., 1.0], i*floatCount); // blue
    }

    const boidBuffer = device.createBuffer({
        label: "boid struct buffer",
        size: boidValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.VERTEX
    });

    

    const bucketStructSize = 8;
    const u32Count = bucketStructSize / 4;
    const bucketCount = bucketRows * bucketCols;
    let bucketValues = new Uint32Array(bucketCount*u32Count);

    const bucketBuffer = device.createBuffer({
        label: "bucket buffer",
        size: bucketValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST 
    });

    const bucketedIds = new Uint32Array(boidCount);

    const bucketedIdsBuffer = device.createBuffer({
        label: "bucketedIds buffer",
        size: bucketedIds.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST 
    });

    // TODO: Unify these bind groups!
    const bucketCountBindGroup = device.createBindGroup({
        label: "compute bind group for bucketCount",
        layout: bucketCountsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    const bucketOffsetBindGroup = device.createBindGroup({
        label: "compute bind group for bucketOffset",
        layout: bucketOffsetsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    const bucketedIdsBindGroup = device.createBindGroup({
        label: "compute bind group for bucketOffset",
        layout: bucketedIdsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    const physicsBindGroup = device.createBindGroup({
        label: "compute bind group for physics",
        layout: physicsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    // Bind group for the vertex and fragment shaders
    const renderBindGroup = device.createBindGroup({
        label: "render bind group for uniforms and ping",
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
        ]
    });

    // Describes how to actually render to screen
    const renderPassDescriptor = {
        label: "canvas renderPass",
        colorAttachments: [ 
            {
                clearValue: [.0, .0, .0, 1], //black clear
                loadOp: 'clear', // clear the screen before starting the render pass
                storeOp: 'store' // actually save to the screen. (we would use discard if this was only an intermediate step)
            }
        ]
    }

    // Set up boids bufer with initial random data
    device.queue.writeBuffer(boidBuffer, 0, boidValues);

    // to be called every frame
    async function computeAndRender() {
        // Clear out buckets each iteration
        // TODO: Explore doing this in a shader instead
        bucketValues = new Uint32Array(bucketCount*u32Count);
        device.queue.writeBuffer(bucketBuffer, 0, bucketValues);

        // Will hold all of the commands to be submitted to the GPU
        const encoder = device.createCommandEncoder({ label: "encoder" });

        const bucketCountPass = encoder.beginComputePass();
        bucketCountPass.setPipeline(bucketCountsPipeline);
        bucketCountPass.setBindGroup(0, bucketCountBindGroup);
        bucketCountPass.dispatchWorkgroups(boidCount);
        bucketCountPass.end();

        ////////////////////////////

        const bucketOffsetPass = encoder.beginComputePass();
        bucketOffsetPass.setPipeline(bucketOffsetsPipeline);
        bucketOffsetPass.setBindGroup(0, bucketOffsetBindGroup);
        bucketOffsetPass.dispatchWorkgroups(1); // I think this has to be done single threaded :(
        bucketOffsetPass.end();

        ///////////////////////////

        const bucketedIdsPass = encoder.beginComputePass();
        bucketedIdsPass.setPipeline(bucketedIdsPipeline);
        bucketedIdsPass.setBindGroup(0, bucketedIdsBindGroup);

        const bucketedIdsWorkgroupSize = [8, 8, 1];

        bucketedIdsPass.dispatchWorkgroups(Math.ceil(bucketCount/(bucketedIdsWorkgroupSize[0]*bucketedIdsWorkgroupSize[1]*bucketedIdsWorkgroupSize[2]))); 
        bucketedIdsPass.end();

        ///////////////////////////

        // in this pass we will encode all of the suff we set up for the physics
        const computePhysicsPass = encoder.beginComputePass();
        computePhysicsPass.setPipeline(physicsPipeline);
        computePhysicsPass.setBindGroup(0, physicsBindGroup);

        // if this changes, it needs to be changed in the shader as well
        const physicsWorkgroupSize = [8, 8, 1];

        computePhysicsPass.dispatchWorkgroups(Math.ceil(boidCount/(physicsWorkgroupSize[0]*physicsWorkgroupSize[1]*physicsWorkgroupSize[2])));
        computePhysicsPass.end();

        // Canvas has a new texture each frame, so we need to make sure we're drawing
        // to the one for the current frame.
        renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();

        // let's do another pass for the rendering~
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, boidCount); // 3 vertices per boid
        renderPass.end();

        const commandBuffer = encoder.finish();

        // Actually send the whole shebang to the jeep y you
        device.queue.submit([commandBuffer]);
    }

    // Resize canvas resolution when screen resized yada yada yada
    // I don't actually really care about this part
    const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
            const canvas = entry.target;
            const width = entry.contentBoxSize[0].inlineSize;
            const height = entry.contentBoxSize[0].blockSize;
            canvas.width = Math.max(1, Math.min(width, device.limits.maxTextureDimension2D));
            canvas.height = Math.max(1, Math.min(height, device.limits.maxTextureDimension2D));
        }
    });
    observer.observe(canvas);

    let pointerX = 0;
    let pointerY = 0;
    let pointerHeld = 0;

    canvas.addEventListener("pointermove", () => {
        // Rescale to -1 to +1, the scaling used by the compute/vertex shaders
        pointerX = (2 * event.clientX / canvas.width) - 1;
        pointerY = -((2 * event.clientY / canvas.height) - 1);
    });
    canvas.addEventListener('pointerdown', () => { pointerHeld = 1; });
    canvas.addEventListener('pointerup', () => { pointerHeld = 0; });
    canvas.addEventListener('pointeleave', () => { pointerHeld = 0; });
    canvas.addEventListener('pointercancel', () => { pointerHeld = 0; });

    function frame(timestamp) {
        uniformData[0] = pointerX;
        uniformData[1] = pointerY;
        uniformData[2] = pointerHeld;
        uniformData[3] = timestamp / 1000;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        computeAndRender();
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

main();