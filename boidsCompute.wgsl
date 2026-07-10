// Ideating boids struct:

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
    time : f32,
    xShift : f32, // not needed, can remove
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
    let myIdx = id.x;
    let me = boidsOld[myIdx];
    let boidCount = arrayLength(&boidsOld);

    // Adding a dummy for now so uniforms doesn't get tossed
    let dummy = uniforms.xShift;

    // tuneable!
    let sightRadius = .05;
    let sepFactor = .08;
    let alignFactor = .5;
    let cohesionFactor = .01;
    let edgeFactor = .0001;
    let wall = 1.05;
    let minSpeed = .010;
    let speedUp = 1.01;


    var sepVec = vec2f(0, 0);
    var neighborCount = 0u;

    var avgNeighborVel = vec2f(0, 0);

    var center = vec2f(0, 0);

    // TODO: bucketing so this isn't n^2
    for (var i = 0u; i< boidCount; i++) {
        if(myIdx == i) {continue;} // don't include self in averages
        let other = boidsOld[i];

        let delta = me.position - other.position;

        // Check if within sight radius
        // Could prob be done faster comparing squared distances
        let dist = length(delta);
        if(dist > sightRadius) {continue;}
        neighborCount++;

        sepVec += (sightRadius -dist) * delta;
        // sepVec += delta;
        avgNeighborVel += other.velocity;

        center += other.position;
    }

    var newVel = me.velocity;
    

    if(neighborCount > 0) {
        newVel += sepVec * sepFactor;

        avgNeighborVel /= f32(neighborCount);
        newVel += (avgNeighborVel-me.velocity) * alignFactor;

        center /= f32(neighborCount);
        newVel += (center - me.position) * cohesionFactor;
    }



    if (length(newVel) < minSpeed) {newVel *= speedUp;}
    boidsNew[myIdx].velocity = newVel;
    boidsNew[myIdx].position = me.position + newVel;


    if(boidsNew[myIdx].position.x > wall) {
        boidsNew[myIdx].position.x -= 2*wall;
    }
    if(boidsNew[myIdx].position.x < -wall) {
        boidsNew[myIdx].position.x += 2*wall;
    }
    if(boidsNew[myIdx].position.y > wall) {
        boidsNew[myIdx].position.y -= 2*wall;
    }
    if(boidsNew[myIdx].position.y < -wall) {
        boidsNew[myIdx].position.y += 2*wall;
    }
}


// old mouse attract shader, not currently used
@compute @workgroup_size(1) fn updatePositionMouse(@builtin(global_invocation_id) id : vec3u) {
    // let's us get the invocation id's x.
    // We're doing 1d workgroups, so only the x is relevant
    // I THINK this means that we're going to have each... worker? working on a separate element of the array
    // So maybe we'll end up having 1 per boid too? Idk
    let i = id.x;
    var pull = uniforms.mousePos - boidsOld[i].position;
    pull /= length(pull);
    boidsNew[i].velocity = boidsOld[i].velocity + pull/10;
    boidsNew[i].position += boidsNew[i].velocity/1000;
}