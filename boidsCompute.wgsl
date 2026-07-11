// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// CHANGE IT IN THE OTHER SHADER TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    color:    vec4f, // 16 bytes
} // Total 32 bytes

// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
// CHANGE IT IN THE OTHER SHADER TOO
// Corresponds to the uniforms typed array in the JS
struct Uniforms {
    pointerPos : vec2f, // 8 bytes
    pointerHeld : u32, // 4 bytes
    time : f32 // 4 bytes
} // total: 16 bytes

// tuneable! (maybe set as constants?)
override sightRadius : f32; // set exclusively in JS because needed for bucket calc
override sepFactor = .01;
override alignFactor = .5;
override cohesionFactor = .001;
override edgeFactor = .0001;
override wall : f32; // how far off the edge of the screen the boid can get before wrapping
override minSpeed = .010;
override speedUp = 1.01; // if below minSpeed, accelerate by speedUP
override pointerRadius = .2;
override pointerPush = .002;



@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read_write> boids : array<Boid>;

// BUCKET PLANNING
// TODO: Make sure the bucketRows and cols properly holds the sight distance.
override bucketRows : u32;
override bucketCols : u32;

struct Bucket {
    count : atomic<u32>, // How many boids are in this bucket?
    offset : u32 // How many boids are before this bucket?
} // 8 bytes
@group(0) @binding(2) var<storage, read_write> buckets : array<Bucket>;
@group(0) @binding(3) var<storage, read_write> bucketedIds : array<u32>;


// // TODO: explore other clearing options or right workgroup sizes

// Step 1: Copy in empty buckets from CPU (can switch to actual GPU pass if needed, but this should be quite small)
// NEEDS TO BE DONE IS JS

// Step 2: CountBuckets

// TODO: Right workgroup size?
@compute @workgroup_size(1) fn countBuckets(@builtin(global_invocation_index) id : u32) {
    _ = uniforms; // dummy
    _ = bucketedIds[0];
    if(id >= arrayLength(&boids)) { return; }
    let bucketId = bucketIdx(boids[id].position);
    atomicAdd(&(buckets[bucketId].count), 1);
}

fn bucketIdx(position : vec2f) -> u32 {
    // buckets extend from -wall to +wall
    let col = u32(f32(bucketCols) * ((position.x / (2.*wall)) + .5));
    let row = u32(f32(bucketRows) * ((position.y / (2.*wall)) + .5));

    // linear index
    return row*bucketCols + col;
}

// Can only be done single threaded???
@compute @workgroup_size(1) fn bucketOffsets() {
    _ = uniforms; // dummy
    _ = boids[0];
    _ = bucketedIds[0];
    var offset=0u;
    for(var i = 0u; i < arrayLength(&buckets); i++) {
        buckets[i].offset = offset;
        offset += atomicLoad(&(buckets[i].count)); // TODO: Copy to a non-atomic so boids can be more parallel when doing physics?
    }
}

// Should be 1 thread per bucket
// If workgroup sizes change, should change in JS as well
@compute @workgroup_size(8, 8, 1) fn bucketBoids(@builtin(global_invocation_index) id : u32) {
    if(id > arrayLength(&buckets)) {return;}

    _ = uniforms; // dummy
    _ = boids[0];

    var baseOffset = buckets[id].offset;
    var seen = 0u;
    
    for(var i = 0u; i < arrayLength(&boids); i++) {
        // TODO: Make branchless?
        if(bucketIdx(boids[i].position) == id) {
            bucketedIds[baseOffset + seen] = i;
            seen++;
        }
        // TODO: break if seen all?
    }
}



// Splitting the workgroups made a HUGE difference on laptop
// not much of a diff on phone?
// interes...
// if workgroup_size changes, it needs to be changed in the shader as well
@compute @workgroup_size(8, 8, 1) fn updatePosition(@builtin(global_invocation_index) id : u32) {
    _ = buckets[0].offset; // Currently a dummy so the bind groups turn out OK
    _ = bucketedIds[0];

    let myIdx = id;
    // If we have more threads than boids, the extra threads don't need to do anything
    if(myIdx >= arrayLength(&boids)) { return; }

    let me = boids[myIdx]; // Maaaaybe pointer would be better?
    let boidCount = arrayLength(&boids);


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

    if(uniforms.pointerHeld > 0) {
        let delta = me.position - uniforms.pointerPos;
        let deltaLen = length(delta);
        if(deltaLen < pointerRadius) {
            newVel += delta / length(delta) * pointerPush; 
        }
    }

    if (length(newVel) < minSpeed) {newVel *= speedUp;}

    // TODO: re-enable physics!
    boids[myIdx].velocity = newVel;
    boids[myIdx].position = me.position + newVel;


    // Wrap (candidate for separate function? If so, pass boids pointer)
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
    var pull = uniforms.pointerPos - boids[i].position;
    pull /= length(pull);
    boids[i].velocity = boids[i].velocity + pull/10;
    boids[i].position += boids[i].velocity/1000;
}