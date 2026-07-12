import { BoidStruct, BucketStruct, UniformsStruct } from "./structs.js";

export const computeShaderCode = /* wgsl */`
// Import structs
${BoidStruct}
${BucketStruct}
${UniformsStruct}

override sightRadius : f32; 
override protectedRadius : f32;
override sepFactor : f32;
override alignFactor : f32;
override cohesionFactor : f32;
override edgeFactor : f32;
override wall : f32; // how far off the edge of the screen the boid can get before wrapping
override minSpeed : f32;
override speedUp : f32; // if below minSpeed, accelerate by speedUP
override pointerRadius : f32;
override pointerPush : f32;
override bucketRows : u32;
override bucketCols : u32;

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read_write> boids : array<Boid>;
@group(0) @binding(2) var<storage, read_write> buckets : array<Bucket>;
@group(0) @binding(3) var<storage, read_write> bucketedIds : array<u32>;


@compute @workgroup_size(8, 8, 1) fn countBuckets(@builtin(global_invocation_index) id : u32) {
    if(id >= arrayLength(&boids)) { return; }
    let bucketId = bucketIdx(boids[id].position);
    atomicAdd(&(buckets[bucketId].atomicCount), 1);
}

fn bucketCoord(position : vec2f) -> vec2u {
    return vec2u(
        u32(f32(bucketRows) * ((position.y / (2.*wall)) + .5)),
        u32(f32(bucketCols) * ((position.x / (2.*wall)) + .5))
    );
}

fn bucketCoordToIdx(rowCol : vec2u) -> u32 {
    return rowCol.x*bucketCols + rowCol.y;
}

fn bucketIdx(position : vec2f) -> u32 {
    return bucketCoordToIdx(bucketCoord(position));
}

// Can only be done single threaded???
@compute @workgroup_size(1) fn bucketOffsets() {
    var offset=0u;
    for(var i = 0u; i < arrayLength(&buckets); i++) {
        buckets[i].offset = offset;
        // Store the count in a read friendly format and clear the atomic counter for the next iteration
        buckets[i].count = atomicExchange(&(buckets[i].atomicCount), 0);
        offset += buckets[i].count;
    }
}

// Should be 1 thread per bucket
// If workgroup sizes change, should change in JS as well
@compute @workgroup_size(8, 8, 1) fn bucketBoids(@builtin(global_invocation_index) id : u32) {
    if(id > arrayLength(&buckets)) {return;}

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

// Can we make it so that workers are working on the same buckets...
// Would line up a lot of the loops!
@compute @workgroup_size(8, 8, 1) fn updatePosition(@builtin(global_invocation_index) id : u32) {
    // Boids grouped by bucket! This does noticeably improve performance!
    // But due to the cheating non-ping-pong update this introduces a directional bias...
    // Keep this improvement, but swtich to ping pong?

    // Also something VERY weird is going on when we try to do higher dimensional workgroups with this
    let myIdx = bucketedIds[id]; 
    //let myIdx = id;
    let boidCount = arrayLength(&boids);
    // If we have more threads than boids, the extra threads don't need to do anything
    if(myIdx >= boidCount) { return; }

    let me = boids[myIdx]; // Maaaaybe pointer would be better?

    var neighborCount = 0u;
    var sepVec = vec2f();
    var avgNeighborVel = vec2f();
    var center = vec2f();

    // TODO: Store this elsewhere?
    let bucketDeltas = array(
        vec2i(-1, -1),
        vec2i(-1, 0),
        vec2i(-1, 1),
        vec2i(0, -1),
        vec2i(0, 0),
        vec2i(0, 1),
        vec2i(1, -1),
        vec2i(1, 0),
        vec2i(1, 1),
    ); // 8 adjacent and own bucket

    let myBucketCoord = bucketCoord(me.position);

    for(var d = 0u; d < 9; d++) {
        let otherBucketCoordi = vec2i(myBucketCoord) + bucketDeltas[d];
        if(otherBucketCoordi.x < 0 || otherBucketCoordi.y < 0) {continue;}

        let otherBucketCoord = vec2u(otherBucketCoordi);
        if(otherBucketCoord.x >= bucketRows || otherBucketCoord.y >= bucketCols ) {continue;}

        let otherBucketCount = buckets[bucketCoordToIdx(otherBucketCoord)].count;
        let otherBucketOffset = buckets[bucketCoordToIdx(otherBucketCoord)].offset;


        for(var i = otherBucketOffset; i < otherBucketOffset+otherBucketCount; i++) {
            if(myIdx == bucketedIds[i]) {continue;} // don't include self in averages
            let other = boids[bucketedIds[i]];
            let delta = me.position - other.position;

            let squaredDist = dot(delta, delta);

            // TODO: precompute squared radii?
            if(squaredDist > sightRadius*sightRadius) {continue;}
            neighborCount++;


            if (squaredDist < protectedRadius*protectedRadius) {
                sepVec += delta;
            }
            avgNeighborVel += other.velocity;

            center += other.position;
        }
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
        if(deltaLen > 0 && deltaLen < pointerRadius) {
            newVel += delta / deltaLen * pointerPush; 
        }
    }

    if (length(newVel) < minSpeed) {newVel *= speedUp;}

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
`;