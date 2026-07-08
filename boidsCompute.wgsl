// Ideating boids struct:

// IF THIS STRUCT CHANGES, THE JS TYPED ARRAYS NEED TO CHANGE TOO
struct Boid {
    position: vec2f, // 8 bytes
    velocity: vec2f, // 8 bytes
    angle: f32       // 4 bytes
    // pad              4 bytes
} // Total 24 bytes
// Gets extra 4 bytes of padding so the next vec2f can properly be aligned to 8 bytes

// TODO: Update Position Shader