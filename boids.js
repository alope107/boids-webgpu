async function main() {
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


    // Gets compiled when the module is created?
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
    const computePipeline = device.createComputePipeline({
        label: 'compute boids pipeline',
        // Right now 'auto' is letting WebGPU infer the layout of our bind groups
        // Apparently this will cause a performance hit when we try to share a bind group?
        // We'll leave it as-is for now
        layout: 'auto', 
        compute: {
            module: computeModule,
            entryPoint: "updatePosition"
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
//     color:    vec3f, // 12 bytes
//     // pad           // 4 bytes
// } // Total 32 bytes
// // Gets extra 4 bytes of padding so the next vec3f can properly be aligned
    // Changing boid struct? All this needs to change!
    const boidStructSize = 32;
    const floatCount = boidStructSize / 4;
    const boidCount = 1000;
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
        boidViews.color.set([rand(), rand(), rand()], i*floatCount);
    }

    const boidBuffer = device.createBuffer({
        label: "boid struct buffer",
        size: boidValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.VERTEX
    });


    // Bind group for the compute shader
    const computeBindGroup = device.createBindGroup({
        label: "compute bind group for reading from ping and writing to pong",
        layout: computePipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBuffer },
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
                clearValue: [.3, .3, .3, 1], // What color the screen be cleared to
                loadOp: 'clear', // clear the screen before starting the render pass
                storeOp: 'store' // actually save to the screen. (we would use discard if this was only an intermediate step)
            }
        ]
    }

    // Set up ping and pong buffers with the initial data from the CPU
    device.queue.writeBuffer(boidBuffer, 0, boidValues);

    // to be called every frame
    function computeAndRender() {
        // Will hold all of the commands to be submitted to the GPU
        const encoder = device.createCommandEncoder({ label: "encoder" });

        // in this pass we will encode all of the suff we set up for the compute
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        // // ping pong our bind groups
        computePass.setBindGroup(0, computeBindGroup);
        // Workgroups are still unclear to me. Number of cores? Number of tasks?
        // I _think_ it's number of tasks?
        // But it can also be 2 or 3d which I don't understand why that would be needed
        // I think I understand this the least!
        computePass.dispatchWorkgroups(boidCount);
        computePass.end();

        // I think the Canvas has a new texture each frame, so we need to make sure we're drawing
        // to the one for the current frame. Idk tho!
        renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();

        // let's do another pass for the rendering~
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, boidCount); // draw 9 vertices. We will later update this to 3*boidCount
        renderPass.end();

        // We've encoded all the commands!
        // Is this a buffer in the same way to the other Buffers in that it's data
        // that will be allocated on VRAM?
        // Does that mean that a shader could modify this buffer and make self modifying code???
        // Or is it just a buffer in the more pedestrian sense?
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

    let mouseX = 0;
    let mouseY = 0;
    let refreshMouse = (event) => {
        // Rescale to -1 to +1, the scaling used by the vertex shaders
        mouseX = (2 * event.clientX / canvas.width) -1;
        mouseY = -((2* event.clientY / canvas.height)-1);
    };
    window.addEventListener("mousemove", refreshMouse);

    function frame(timestamp) {
        // mess with the uniforms to see them working
        // they get written to the buffer
        uniformData[0] = mouseX;
        uniformData[1] = mouseY;
        uniformData[2] = timestamp / 1000;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        computeAndRender();
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

main();