// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// CHANGE IT IN THE OTHER SHADER TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    angle: f32       // 4 bytes // Not needed anymore, will remove later
    // pad              4 bytes
} // Total 24 bytes
// Gets extra 4 bytes of padding so the next vec2f can properly be aligned to 8 bytes

// Corresponds to the uniforms typed array in the JS
struct Uniforms {
    mousePos : vec2f, // 8 bytes
    time : f32 // 4 bytes
    //pad 4 bytes
} // total: 16 bytes

// Matches our nice bind groups
@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> boids : array<Boid>;

@vertex fn boidVertex(
    @builtin(vertex_index) vertexIndex : u32,
    @builtin(instance_index) instanceIndex : u32
) -> @builtin(position) vec4f {
    let boid_idx = instanceIndex; // Each boid has 3 vertices
    
    let corner = vertexIndex;

    // TODO: Maybe make these offsets uniform? Or variable per boid?
    let cornerOffsets = array<vec2f, 3>(
        vec2f(.03, 0),
        vec2f(0, -.01),
        vec2f(0, .01), 
    );

    let originalAngle = atan2(cornerOffsets[corner].y, cornerOffsets[corner].x);
    
    let newAngle = originalAngle + atan2(boids[boid_idx].velocity.y, boids[boid_idx].velocity.x);

    let rotated = 
        vec2f(length(cornerOffsets[corner]) * cos(newAngle),
              length(cornerOffsets[corner]) * sin(newAngle));

    let basePos = boids[boid_idx].position + rotated;
    let velOffset = boids[boid_idx].velocity * uniforms.time / 10.;


    let originalOrient = atan2(cornerOffsets[0].y, cornerOffsets[0].x);

    return vec4f(basePos, 0., 1.);
}


//pos : position of the pixel (in screen space!)
// @location(0)... f if I know. I'm tired. I'll look at that later
@fragment fn boidFragment(@builtin(position) pos : vec4f) -> @location(0) vec4f {
    return vec4f(pos.x/484.0 * sin(uniforms.time), pos.y/716.0, 1.0, 1.0);
}