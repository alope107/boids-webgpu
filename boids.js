import { configFromQueryParams } from "./config.js";
import { computeShaderCode } from "./computeShaders.js";
import { renderShaderCode } from "./renderShaders.js";
import dispatchCount from "./workgroups.js";

const DEBUG_OUT = false;
const DEBUG_OUT_INTERVAL = 1;
const DEBUG_HALT = 1000;

async function main(config) {
    // Check webGPU support and get device
    const adapter = await navigator.gpu?.requestAdapter({
        powerPreference: 'high-performance', 
        //requiredFeatures: ['timestamp-query'], // will re-enable later for profiling
    });
    const device = await adapter?.requestDevice();
    if(!device) {
        throw new Error("No WebGPU compatible device found");
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

    const computeModule = device.createShaderModule({
        label: "compute boid values shader",
        code: computeShaderCode
    });
    const renderModule = device.createShaderModule({
        label: "render boids shader",
        code: renderShaderCode
    });

    // Compute needed overrides
    // Ensure that buckets are smaller than the sightRadius
    // (field spans from -wall to wall (length of 2*wall))
    const fieldSideLength = 2 * config.overrides.wall;
    const bucketRows = Math.max(Math.ceil(fieldSideLength/config.overrides.sightRadius)-1, 1);
    const bucketCols = Math.max(Math.ceil(fieldSideLength/config.overrides.sightRadius)-1, 1);

    const computeOverrides = {
        ...config.overrides,
        bucketRows,
        bucketCols
    };

    // Our pipelines define how our bind groups are laid out
    // and which shader functions should be called
    const bucketCountsPipeline = device.createComputePipeline({
        label: 'compute bucketCounts pipeline',
        // TODO: Set up bind group manually because it's shared across the different compute stages
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "countBuckets", // Counts how many boids in each bucket
            constants: computeOverrides
        },
    });
    const bucketOffsetsPipeline = device.createComputePipeline({
        label: 'compute bucketOffsets pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "bucketOffsets", // Calculate where in the ids array each bucket will start/end
            constants: computeOverrides
        },
    });
    const bucketedIdsPipeline = device.createComputePipeline({
        label: 'compute bucketedIds pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "bucketBoids", // place boid ids into buckets
            constants: computeOverrides
        },
    });
    const physicsPipeline = device.createComputePipeline({
        label: 'compute physics pipeline',
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "updatePosition",
            constants: computeOverrides
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


// struct Uniforms {
//     pointerPos : vec2f, // 8 bytes
//     pointerHeld : u32, // 4 bytes
//     time : f32,  // 4 bytes
//     translate : vec2f, // 8 bytes
//     zoom : f32  // 4 bytes
//     // pad 4 bytes
// } // total: 32 bytes
    const uniformFloatCount = 8;
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
    const boidValues = new ArrayBuffer(config.boidCount * boidStructSize);
    // Views can be recomputed here: https://webgpufundamentals.org/webgpu/lessons/resources/wgsl-offset-computer.html
    const boidViews = {
        position: new Float32Array(boidValues, 0),
        velocity: new Float32Array(boidValues, 8),
        color: new Float32Array(boidValues, 16),
    };

    let rand = (min, max) => Math.random() * (max-min) + min; // random in range
    let randInside = () => rand(-1, 1); // random inside vertex coordinate space

    for(let i = 0; i < config.boidCount; i++) {
        boidViews.position.set([randInside(), randInside()], i*floatCount);
        boidViews.velocity.set([randInside()*.05, randInside()*.05], i*floatCount);
        boidViews.color.set(config.colorFn(), i*floatCount); // blue
    }

    const boidBuffer = device.createBuffer({
        label: "boid struct buffer",
        size: boidValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.COPY_SRC | // Just needed for debuggling. Good idea to remove otherwise? Or does it not hurt?
               GPUBufferUsage.VERTEX
    });

    let debugBoidBuffer;
    if(DEBUG_OUT) {
        debugBoidBuffer = device.createBuffer({
            label: "debug boid buffer",
            size: boidValues.byteLength,
            usage: 
                GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
    }


    // IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
    // struct Bucket {
    //     atomicCount : atomic<u32>, // How many boids are in this bucket? (atomic as it's collab built)
    //     count: u32, // non-atomic for reading
    //     offset : u32 // How many boids are before this bucket?
    // } // 12 bytes

    const bucketStructSize = 12;
    const u32Count = bucketStructSize / 4;
    const bucketCount = bucketRows * bucketCols;
    let bucketValues = new Uint32Array(bucketCount*u32Count);

    const bucketBuffer = device.createBuffer({
        label: "bucket buffer",
        size: bucketValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST 
    });

    const bucketedIds = new Uint32Array(config.boidCount);

    const bucketedIdsBuffer = device.createBuffer({
        label: "bucketedIds buffer",
        size: bucketedIds.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST 
    });

    const bucketCountBindGroup = device.createBindGroup({
        label: "compute bind group for bucketCount",
        layout: bucketCountsPipeline.getBindGroupLayout(0), 
        entries: [
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
        ]
    });

    const bucketOffsetBindGroup = device.createBindGroup({
        label: "compute bind group for bucketOffset",
        layout: bucketOffsetsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 2, resource: bucketBuffer },
        ]
    });

    const bucketedIdsBindGroup = device.createBindGroup({
        label: "compute bind group for bucketedIds",
        layout: bucketedIdsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    const physicsBindGroup = device.createBindGroup({
        label: "compute bind group for physics",
        layout: physicsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
            { binding: 2, resource: bucketBuffer },
            { binding: 3, resource: bucketedIdsBuffer },
        ]
    });

    // Bind group for the vertex and fragment shaders
    const renderBindGroup = device.createBindGroup({
        label: "render bind group",
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

    // Clear out buckets bwfore first iteration
    bucketValues = new Uint32Array(bucketCount*u32Count);
    device.queue.writeBuffer(bucketBuffer, 0, bucketValues);

    // only used for debug
    let fc = 0;

    // to be called every frame
    async function computeAndRender() {
        // Will hold all of the commands to be submitted to the GPU
        const encoder = device.createCommandEncoder({ label: "encoder" });

        /////////////////////////////

        const bucketCountPass = encoder.beginComputePass();
        bucketCountPass.setPipeline(bucketCountsPipeline);
        bucketCountPass.setBindGroup(0, bucketCountBindGroup);
        bucketCountPass.dispatchWorkgroups(dispatchCount(config.boidCount, [8, 8, 1]));
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
        bucketedIdsPass.dispatchWorkgroups(dispatchCount(bucketCount, [8, 8, 1])); 
        bucketedIdsPass.end();

        ///////////////////////////

        // in this pass we will encode all of the suff we set up for the physics
        const computePhysicsPass = encoder.beginComputePass();
        computePhysicsPass.setPipeline(physicsPipeline);
        computePhysicsPass.setBindGroup(0, physicsBindGroup);
        computePhysicsPass.dispatchWorkgroups(dispatchCount(config.boidCount, [8, 8, 1]));
        // Have I been dispatching 1d still?
        // computePhysicsPass.dispatchWorkgroups(Math.max(1, config.boidCount /64), Math.max(1, config.boidCount /64), 1);
        computePhysicsPass.end();

        ///////////////////////////

        // Canvas has a new texture each frame, so we need to make sure we're drawing
        // to the one for the current frame.
        renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();

        // let's do another pass for the rendering~
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, config.boidCount); // 3 vertices per boid
        renderPass.end();

        
        if(DEBUG_OUT) encoder.copyBufferToBuffer(boidBuffer, 0, debugBoidBuffer, 0, boidBuffer.size);

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

    // Todo: multiple pointers?
    let pointerX = 0;
    let pointerY = 0;
    let pointerHeld = 0;
    let translate = [0, 0];
    let zoom = 1.;

    canvas.addEventListener("pointermove", () => {
        // Rescale to -1 to +1, the scaling used by the compute/vertex shaders
        pointerX = (2 * event.clientX / canvas.width) - 1;
        pointerY = -((2 * event.clientY / canvas.height) - 1);
    });
    canvas.addEventListener('pointerdown', () => { pointerHeld = 1; });
    canvas.addEventListener('pointerup', () => { pointerHeld = 0; });
    canvas.addEventListener('pointeleave', () => { pointerHeld = 0; });
    canvas.addEventListener('pointercancel', () => { pointerHeld = 0; });

    window.addEventListener("keydown", (e) => {
        if(e.key === "x") zoom += .02;
        if(e.key === "z") zoom -= .02;

        if(e.key === "w") translate[1] -= .02;
        if(e.key === "a") translate[0] += .02;
        if(e.key === "s") translate[1] += .02;
        if(e.key === "d") translate[0] -= .02;
    });


    

    async function frame(timestamp) {
        uniformData[0] = pointerX;
        uniformData[1] = pointerY;
        uniformData[2] = pointerHeld;
        uniformData[3] = timestamp / 1000;
        uniformData[4] = translate[0];
        uniformData[5] = translate[1];
        uniformData[6] = zoom;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);
        


        computeAndRender();

        if (DEBUG_OUT) {
            
            if(fc % DEBUG_OUT_INTERVAL == 0) {
                await debugBoidBuffer.mapAsync(GPUMapMode.READ);
                const result = Array.from(new Float32Array(debugBoidBuffer.getMappedRange()));
                console.log('result', result);
                    
                debugBoidBuffer.unmap();
            }
            fc++;
            if(fc == DEBUG_HALT) return;
        }
        
        requestAnimationFrame(frame);
        
    }
    requestAnimationFrame(frame);
}

main(configFromQueryParams());