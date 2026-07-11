async function main() {
    // Tunables!
    const sightRadius = .04;
    const wall = 1.05;

    // Ensure that buckets are smaller than the sightRadius
    // (field spans from -wall to wall (length of 2*wall))
    const fieldSideLength = 2 * wall;
    // TODO set back after bucket count validated
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
    // I think this is things like RGB vs BGR, bpp and the like
    const ctx = canvas.getContext("webgpu");
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device,
        format: presentationFormat
    });

    // load shaders from wgsl files
    // Probably could do this all within one Promise.all?
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
        // Right now 'auto' is letting WebGPU infer the layout of our bind groups
        // Apparently this will cause a performance hit when we try to share a bind group?
        // We'll leave it as-is for now
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "countBuckets",
            constants: {
                sightRadius: sightRadius,
                wall: wall,
                bucketRows: bucketRows,
                bucketCols: bucketCols
            }
        },
    });
    const bucketOffsetsPipeline = device.createComputePipeline({
        label: 'compute bucketOffsets pipeline',
        // Right now 'auto' is letting WebGPU infer the layout of our bind groups
        // Apparently this will cause a performance hit when we try to share a bind group?
        // We'll leave it as-is for now
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "bucketOffsets",
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
        // Right now 'auto' is letting WebGPU infer the layout of our bind groups
        // Apparently this will cause a performance hit when we try to share a bind group?
        // We'll leave it as-is for now
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
            //entryPoint: "updatePositionMouse" // swap to me if u want mouse attract instead of actual boids
        },
    });
    const renderPipeline = device.createRenderPipeline({
        label: 'render boids pipeline',
        layout: 'auto', // ditto on the auto layout from above
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
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.COPY_SRC // Copy src can be removed later, here for debuggling purposes
    });

    const debugBucketCountBuffer = device.createBuffer({
        label: "debug bucket count buffer",
        size: bucketValues.byteLength,
        usage: 
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.MAP_READ 
    });

    const bucketCountBindGroup = device.createBindGroup({
        label: "compute bind group for bucketCount",
        layout: bucketCountsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer }
        ]
    });

    const bucketOffsetBindGroup = device.createBindGroup({
        label: "compute bind group for bucketOffset",
        layout: bucketOffsetsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer }
        ]
    });

    const physicsBindGroup = device.createBindGroup({
        label: "compute bind group for physics",
        layout: physicsPipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer }
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
                //clearValue: [.3, .3, .3, 1], // grey clear
                clearValue: [.0, .0, .0, 1], //black clear
                loadOp: 'clear', // clear the screen before starting the render pass
                storeOp: 'store' // actually save to the screen. (we would use discard if this was only an intermediate step)
            }
        ]
    }

    // Set up boids bufer with initial random data
    device.queue.writeBuffer(boidBuffer, 0, boidValues);

    let frameCount = 0;

    // to be called every frame
    async function computeAndRender() {
        // Clear out buckets each iteration
        // TODO: Explore maybe doing this in a shader instead?... it's small though
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

        // in this pass we will encode all of the suff we set up for the physics
        const computePhysicsPass = encoder.beginComputePass();
        computePhysicsPass.setPipeline(physicsPipeline);
        computePhysicsPass.setBindGroup(0, physicsBindGroup);

        // if this changes, it needs to be changed in the shader as well
        let workgroupSize = [8, 8, 1];

        computePhysicsPass.dispatchWorkgroups(Math.ceil(boidCount/(workgroupSize[0]*workgroupSize[1]*workgroupSize[2])));
        computePhysicsPass.end();

        // I think the Canvas has a new texture each frame, so we need to make sure we're drawing
        // to the one for the current frame. Idk tho!
        renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();

        // let's do another pass for the rendering~
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, boidCount); // draw 9 vertices. We will later update this to 3*boidCount
        renderPass.end();

        //DISABLE WHEN NOT DEBUG
        encoder.copyBufferToBuffer(bucketBuffer, 0, debugBucketCountBuffer, 0, bucketBuffer.size);

        const commandBuffer = encoder.finish();

        // Actually send the whole shebang to the jeep y you
        device.queue.submit([commandBuffer]);

        if(frameCount % 100 === 0) {
            await debugBucketCountBuffer.mapAsync(GPUMapMode.READ);
            const result = new Uint32Array(debugBucketCountBuffer.getMappedRange());
            console.log(Array.from(result));
            debugBucketCountBuffer.unmap();
        }
        frameCount++;
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
        // Rescale to -1 to +1, the scaling used by the vertex shaders
        pointerX = (2 * event.clientX / canvas.width) -1;
        pointerY = -((2* event.clientY / canvas.height)-1);
    });

    canvas.addEventListener('pointerdown', () => { pointerHeld = 1; });

    canvas.addEventListener('pointerup', () => { pointerHeld = 0; });
    canvas.addEventListener('pointeleave', () => { pointerHeld = 0; });
    canvas.addEventListener('pointercancel', () => { pointerHeld = 0; });

    function frame(timestamp) {
        // mess with the uniforms to see them working
        // they get written to the buffer
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