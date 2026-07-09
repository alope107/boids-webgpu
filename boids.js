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


    // I think the shader code gets compiled when the module is created?
    const computeModule = device.createShaderModule({
        label: "compute boid values shader",
        code: computeShaderCode
    });
    const renderModule = device.createShaderModule({
        label: "render boids shader",
        code: renderShaderCode
    });

    // Our pipelines define how our bind groups (read: buffers?) are laid out
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

    // ---------------- START DUMMY ------------------
    // TODO set initial boid positions
    // TODO use boids instead of dummy stuff

    // THESE ARE DUMMY BUFFERS FOR VALIDATING SETUP
    // REMOVE ONCE ACTUALLY IMPLEMENTING BOIDS

    const uniformCount = 2;
    const uniformData = new Float32Array(uniformCount);


    const uniformBuffer = device.createBuffer({
        label: "dummy uniform buffer",
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | // We'll be using it as uniform (think globals) in the shaders
               GPUBufferUsage.COPY_DST  // We need this because we'll be copying to it from the CPU
    });

    // We will ping pong back and forth between these data
    // In the actual boids we'll do this to allow all boids to look at the previous locations
    // of their neighbors to avoid data races (though realistically the data race wouldn't really harm the viz I don't think)
    const ping = new Float32Array([.2, .3, .7]);
    const pong = new Float32Array([0, 0, 0]);


    // ----------------- END DUMMY -------------------

    // Buffers are stored in GPU VRAM
    // Here we will define how we want to allocate space for them
    const pingBuffer = device.createBuffer({
        label: "ping buffer",
        size: ping.byteLength,
        usage: GPUBufferUsage.STORAGE  | // Storage is for big data, unlike uniforms
               GPUBufferUsage.COPY_DST | // We'll start by copying from the CPU
               GPUBufferUsage.VERTEX     // We want to use it in the vertex shader
    });
    const pongBuffer = device.createBuffer({ // Same as ping buffer
        label: "pong buffer",
        size: pong.byteLength,
        usage: GPUBufferUsage.STORAGE  |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.VERTEX 
    });

    // THIS AIN'T USED YET
    // Changing boid struct? All this needs to change!
    const boidStructSize = 24;
    const floatCount = boidStructSize / 4;
    const boidCount = 10000;
    const boidValues = new ArrayBuffer(boidCount * boidStructSize);
    console.log(boidValues);
    // Views can be recomputed here: https://webgpufundamentals.org/webgpu/lessons/resources/wgsl-offset-computer.html
    const boidViews = {
        position: new Float32Array(boidValues, 0),
        velocity: new Float32Array(boidValues, 8),
        angle: new Float32Array(boidValues, 16),
    };
    console.log(boidViews);

    let jsBoids = [];

    let rand = (min, max) => Math.random() * (max-min) + min;
    let randInside = () => rand(-1, 1);

    for(let i = 0; i < boidCount; i++) {
        boidViews.position.set([randInside(), randInside()], i*floatCount);
        boidViews.velocity.set([randInside(), randInside()], i*floatCount);
        boidViews.angle.set([rand(0, 2*Math.PI)], i*floatCount);
    }

    const boidBufferPing = device.createBuffer({
        label: "boid struct buffer ping",
        size: boidValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.VERTEX
    });

    const boidBufferPong = device.createBuffer({
        label: "boid struct buffer pong",
        size: boidValues.byteLength,
        usage: GPUBufferUsage.STORAGE |
               GPUBufferUsage.COPY_DST |
               GPUBufferUsage.VERTEX
    });

    // Bind groups for the compute shader
    // Bind groups will define the mappings of how the shaders will access the data
    // Here we'll make ping->pong and pong->ping bind groups
    // We can swap them in JS, meaning that the shader doesn't need to know
    // that it's being flipped back and forth! It'll just treat whatever's at binding 0
    // as the old and binding 1 as the new
    // We need both the ping and pong in the compute shader, but (for now) we don't need the uniform)
    const computeBindGroupPingToPong = device.createBindGroup({
        label: "compute bind group for reading from ping and writing to pong",
        layout: computePipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            {binding: 0, resource: boidBufferPing},
            {binding: 1, resource: boidBufferPong},
        ]
    });
    const computeBindGroupPongToPing = device.createBindGroup({
        label: "compute bind group for reading from pong and writing to ping",
        layout: computePipeline.getBindGroupLayout(0), // when pipeline layout is not auto maybe this will have to change?
        entries: [
            {binding: 0, resource: boidBufferPong},
            {binding: 1, resource: boidBufferPing},
        ]
    });

    // For the render pipeline we'll pass it the uniforms but only one of ping or pong
    const renderBindGroupPing = device.createBindGroup({
        label: "render bind group for uniforms and ping",
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBufferPing },
        ]
    });
    const renderBindGroupPong = device.createBindGroup({
        label: "render bind group for uniforms and pong",
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: uniformBuffer },
            { binding: 1, resource: boidBufferPong }
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
    device.queue.writeBuffer(boidBufferPing, 0, boidValues);
    device.queue.writeBuffer(boidBufferPong, 0, boidValues);

    let pingToPong = true;
    // to be called every frame
    function computeAndRender() {
        // Will hold all of the commands to be submitted to the GPU
        const encoder = device.createCommandEncoder({ label: "encoder" });

        // // New rando boids every frame!
        // for(let i = 0; i < boidCount; i++) {
        //     boidViews.position.set([randInside(), randInside()], i*floatCount);
        //     boidViews.velocity.set([randInside(), randInside()], i*floatCount);
        //     boidViews.angle.set([rand(0, 360)], i*floatCount);
        // }
        // device.queue.writeBuffer(boidBuffer, 0, boidValues);


        // SKIPPING COMPUTE PASS FOR NOW
        // in this pass we will encode all of the suff we set up for the compute
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        // // ping pong our bind groups
        computePass.setBindGroup(0,
            pingToPong ? computeBindGroupPingToPong : computeBindGroupPongToPing);
        // Workgroups are still unclear to me. Number of cores? Number of tasks?
        // I _think_ it's number of tasks?
        // But it can also be 2 or 3d which I don't understand why that would be needed
        // I think I understand this the least!
        //computePass.dispatchWorkgroups(ping.length);
        computePass.dispatchWorkgroups(boidCount);
        computePass.end();

        // I think the Canvas has a new texture each frame, so we need to make sure we're drawing
        // to the one for the current frame. Idk tho!
        renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();

        // let's do another pass for the rendering~
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0,
            pingToPong ? renderBindGroupPing : renderBindGroupPong);
        renderPass.draw(3*boidCount); // draw 9 vertices. We will later update this to 3*boidCount
        renderPass.end();

        // We've encoded all the commands!
        // Is this a buffer in the same way to the other Buffers in that it's data
        // that will be allocated on VRAM?
        // Does that mean that a shader could modify this buffer and make self modifying code???
        // Or is it just a buffer in the more pedestrian sense?
        const commandBuffer = encoder.finish();

        // Actually send the whole shebang to the jeep y you
        device.queue.submit([commandBuffer]);

        // flip the ping pong
        pingToPong = !pingToPong;
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

    function frame(timestamp) {
        // mess with the uniforms to see them working
        // they get written to the 
        uniformData[0] = timestamp / 1000;
        uniformData[1] += -.001;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        computeAndRender();

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

main();