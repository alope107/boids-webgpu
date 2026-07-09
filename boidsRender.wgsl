// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// CHANGE IT IN THE OTHER SHADER TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    angle: f32       // 4 bytes
    // pad              4 bytes
} // Total 24 bytes
// Gets extra 4 bytes of padding so the next vec2f can properly be aligned to 8 bytes

// Corresponds to the 2 element uniforms typed array in the JS
struct Uniforms {
    time : f32,
    xShift : f32
}

// Matches our nice bind groups
@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> nums : array<f32>;
@group(0) @binding(2) var<storage, read> boids : array<Boid>;

@vertex fn boidVertex(
    @builtin(vertex_index) vertexIndex : u32
) -> @builtin(position) vec4f {
    let boid_idx = vertexIndex / 3; // Each boid has 3 vertices

    // TODO: Maybe make these offsets uniform?
    let corner = vertexIndex % 3;

    let cornerOffsets = array<vec2f, 3>(
        vec2f(0*nums[0], .2), // using nums[0] so as to keep it from disappearing and messing up the bind group
        vec2f(-.1, -.1),
        vec2f(.1, -.1)
    );

    let rotated = 
        vec2f(length(cornerOffsets[corner]) * cos(atan2(cornerOffsets[corner].y, cornerOffsets[corner].x) + boids[boid_idx].angle),
              length(cornerOffsets[corner]) * sin(atan2(cornerOffsets[corner].y, cornerOffsets[corner].x) + boids[boid_idx].angle));

    let basePos = boids[boid_idx].position + rotated;
    let velOffset = boids[boid_idx].velocity * uniforms.time / 10.;
    
    return vec4f(basePos + velOffset, 0., 1.);
}

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
@fragment fn boidFragment(@builtin(position) pos : vec4f) -> @location(0) vec4f {
    return vec4f(pos.x/484.0 * sin(uniforms.time), pos.y/716.0, 1.0, 1.0);
}