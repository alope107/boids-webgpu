// Ideating boids struct:

// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    angle: f32       // 4 bytes
    // pad              4 bytes
} // Total 24 bytes
// Gets extra 4 bytes of padding so the next vec2f can properly be aligned to 8 bytes


// TODO: have these be arrays of boids
// These arrays are referenced in VRAM according the bindGroups set up in the JS
// The shader doesn't need to know about the pinging and ponging!
@group(0) @binding(0) var<storage, read_write> oldData : array<f32>;
@group(0) @binding(1) var<storage, read_write> newData : array<f32>;


// Just modifies some data uselessly
// Still don't get workgroups
@compute @workgroup_size(1) fn scale(@builtin(global_invocation_id) id : vec3u) {
    // let's us get the invocation id's x.
    // We're doing 1d workgroups, so only the x is relevant
    // I THINK this means that we're going to have each... worker? working on a separate element of the array
    // So maybe we'll end up having 1 per boid too? Idk
    let i = id.x;
    // dummy transform
    newData[i] = oldData[i] + 0.001;
}