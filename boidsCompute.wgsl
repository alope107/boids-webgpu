// Ideating boids struct:

// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// CHANGE IT IN THE OTHER SHADER TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    angle: f32       // 4 bytes
    // pad              4 bytes
} // Total 24 bytes
// Gets extra 4 bytes of padding so the next vec2f can properly be aligned to 8 bytes

// Corresponds to the uniforms typed array in the JS
struct Uniforms {
    time : f32,
    xShift : f32,
    mousePos : vec2f
}


// TODO: have these be arrays of boids
// These arrays are referenced in VRAM according the bindGroups set up in the JS
// The shader doesn't need to know about the pinging and ponging!
@group(0) @binding(0) var<storage, read_write> boidsOld : array<Boid>;
@group(0) @binding(1) var<storage, read_write> boidsNew : array<Boid>;
@group(0) @binding(2) var<uniform> uniforms : Uniforms;


// Just modifies some data uselessly
// Still don't get workgroups
@compute @workgroup_size(1) fn updatePosition(@builtin(global_invocation_id) id : vec3u) {
    // let's us get the invocation id's x.
    // We're doing 1d workgroups, so only the x is relevant
    // I THINK this means that we're going to have each... worker? working on a separate element of the array
    // So maybe we'll end up having 1 per boid too? Idk
    let i = id.x;
    // dummy transform
    // boidsNew[id.x].angle = boidsOld[id.x].angle + .01;
    // boidsNew[id.x].velocity.x = boidsOld[id.x].velocity.x + .1;
    // var av = vec2f();
    // for(var i = 0; i < 1000; i++) {
    //     av += boidsOld[i].velocity;
    // }
    // av /= 1000;
    // let newVel = ((av*.09) + (boidsOld[id.x].velocity*1.91)) /2. + (0. *uniforms.mousePos.x);
    var pull = uniforms.mousePos - boidsOld[id.x].position;
    pull /= length(pull);
    boidsNew[id.x].velocity = boidsOld[id.x].velocity + pull/10;
    boidsNew[id.x].position += boidsNew[id.x].velocity/1000;
}