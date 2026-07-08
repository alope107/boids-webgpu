// TODO: boidVertex
// TODO: boidFragment

// Corresponds to the 2 element uniforms typed array in the JS
struct Uniforms {
    time : f32,
    xShift : f32
}

// Matches our nice bind groups
@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> nums : array<f32>;

// Dummy function for just making some triangles
@vertex fn hardcodedTriangles(
    @builtin(vertex_index) vertexIndex : u32, // automatically populated!
) -> @builtin(position) vec4f {
    
    // Just some dummy triangles
    let pos = array(
        vec2f(0.0, -1.0 * sin(uniforms.time)),
        vec2f(-0.5* sin(uniforms.time), -0.5),
        vec2f(0.5, -0.5),

        vec2f(1.0 + uniforms.xShift, 1.0),
        vec2f(.8 + uniforms.xShift, .8),
        vec2f(.6 + uniforms.xShift, .8),

        vec2f(nums[0], 1.0),
        vec2f(nums[1], .8),
        vec2f(nums[2], .8),
    );
    
    // Gets the x/y, z is 0, w is 1
    // w is 1/w from clip-space. A mystery for another day!
    return vec4f(pos[vertexIndex], 0.0, 1.0);
}


//pos : position of the pixel (in screen space!)
// @location(0)... f if I know. I'm tired. I'll look at that later
@fragment fn gradient(@builtin(position) pos : vec4f) -> @location(0) vec4f {
    return vec4f(pos.x/484.0 * sin(uniforms.time), pos.y/716.0, 1.0, 1.0);
}