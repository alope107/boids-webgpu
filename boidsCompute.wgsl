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


@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read_write> boids : array<Boid>;

@compute @workgroup_size(1) fn updatePosition(@builtin(global_invocation_id) id : vec3u) {
        // Adding a dummy for now so uniforms doesn't get tossed
    _ = uniforms;
    // let's us get the invocation id's x.
    // We're doing 1d workgroups, so only the x is relevant
    // I THINK this means that we're going to have each... worker? working on a separate element of the array
    // So maybe we'll end up having 1 per boid too? Idk
    let myIdx = id.x;
    let me = boids[myIdx]; // Maaaaybe pointer would be better?
    let boidCount = arrayLength(&boids);


    // tuneable! (maybe set as constants?)
    let sightRadius = .04;
    let sepFactor = .01;
    let alignFactor = .5;
    let cohesionFactor = .001;
    let edgeFactor = .0001;
    let wall = 1.05; // how far off the edge of the screen the boid can get before wrapping
    let minSpeed = .010;
    let speedUp = 1.01; // if below minSpeed, accelerate by speedUP 


    var neighborCount = 0u;
    var sepVec = vec2f();
    var avgNeighborVel = vec2f();
    var center = vec2f();

    // TODO: bucketing so this isn't n^2
    for (var i = 0u; i< boidCount; i++) {
        if(myIdx == i) {continue;} // don't include self in averages
        let other = boids[i];
        let delta = me.position - other.position;

        // Check if within sight radius
        // Could prob be done faster comparing squared distances
        let dist = length(delta);
        if(dist > sightRadius) {continue;}
        neighborCount++;

        sepVec += ((sightRadius -dist)/dist) * delta;
        // sepVec += delta; // this is more the classic boids way, but has caused problems for me?
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
    boids[myIdx].velocity = newVel;
    boids[myIdx].position = me.position + newVel;


    // Wrap
    if(boids[myIdx].position.x > wall) {
        boids[myIdx].position.x -= 2*wall;
    }
    if(boids[myIdx].position.x < -wall) {
        boids[myIdx].position.x += 2*wall;
    }
    if(boids[myIdx].position.y > wall) {
        boids[myIdx].position.y -= 2*wall;
    }
    if(boids[myIdx].position.y < -wall) {
        boids[myIdx].position.y += 2*wall;
    }
}


// old mouse attract shader, not currently used
@compute @workgroup_size(1) fn updatePositionMouse(@builtin(global_invocation_id) id : vec3u) {
    // let's us get the invocation id's x.
    // We're doing 1d workgroups, so only the x is relevant
    // I THINK this means that we're going to have each... worker? working on a separate element of the array
    // So maybe we'll end up having 1 per boid too? Idk
    let i = id.x;
    var pull = uniforms.mousePos - boids[i].position;
    pull /= length(pull);
    boids[i].velocity = boids[i].velocity + pull/10;
    boids[i].position += boids[i].velocity/1000;
}