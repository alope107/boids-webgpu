import { BoidStruct, UniformsStruct } from "./structs.js";

export const renderShaderCode = /* wgsl */ `
// import structs
${BoidStruct}
${UniformsStruct}

struct VertexOutput {
    @builtin(position) position : vec4f,
    @location(0) color : vec4f
}

// Matches our nice bind groups
@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> boids : array<Boid>;

@vertex fn boidVertex(
    @builtin(vertex_index) vertexIdx : u32,
    @builtin(instance_index) boidIdx : u32
) -> VertexOutput {
    _ = uniforms; // dummy so uniforms don't get thrown away

    // TODO: Maybe make these offsets uniform? Or variable per boid?
    let cornerOffsets = array<vec2f, 3>(
        vec2f(.03, 0),
        vec2f(0, -.01),
        vec2f(0, .01), 
    );

    // Definitely faster/better ways to do this, but probably not bottleneck rn
    let originalAngle = atan2(cornerOffsets[vertexIdx].y, cornerOffsets[vertexIdx].x);
    let newAngle = originalAngle + atan2(boids[boidIdx].velocity.y, boids[boidIdx].velocity.x);
    let rotated = 
        vec2f(length(cornerOffsets[vertexIdx]) * cos(newAngle),
              length(cornerOffsets[vertexIdx]) * sin(newAngle));

    let newPos = boids[boidIdx].position + rotated;

    return VertexOutput(
        vec4f(newPos, 0., 1.),
        boids[boidIdx].color // use the color o' the boid
    );
}

// Output of vertex is input to fragment!
@fragment fn boidFragment(fragInput : VertexOutput) -> @location(0) vec4f {
    return fragInput.color;
}
`;