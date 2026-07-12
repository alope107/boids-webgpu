export const BoidStruct = /* wgsl */ `
// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    color:    vec4f, // 16 bytes
} // Total 32 bytes
`;

export const BucketStruct = /* wgsl */ `
// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
struct Bucket {
    atomicCount : atomic<u32>, // How many boids are in this bucket? (atomic as it's collab built)
    count: u32, // non-atomic for reading
    offset : u32 // How many boids are before this bucket?
} // 12 bytes
`;

export const UniformsStruct = /* wgsl */ `
// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
struct Uniforms {
    pointerPos : vec2f, // 8 bytes
    pointerHeld : u32, // 4 bytes
    time : f32,  // 4 bytes
    translate : vec2f, // 8 bytes
    zoom : f32  // 4 bytes
    // pad 4 bytes
} // total: 32 bytes
`;