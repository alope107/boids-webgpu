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
            entryPoint: updatePosition
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
            module: renderModule
        }
    });

    // Changing boid struct? All this needs to change!
    const boidStructSize = 24;
    const boidCount = 10;
    const boidValues = new ArrayBuffer(boidCount * boidStructSize);
    // Views can be recomputed here: https://webgpufundamentals.org/webgpu/lessons/resources/wgsl-offset-computer.html
    const boidViews = {
        position: new Float32Array(BoidValues, 0, 2),
        velocity: new Float32Array(BoidValues, 8, 2),
        angle: new Float32Array(BoidValues, 16, 1),
    };

    // TODO set initial boid positions

    

}