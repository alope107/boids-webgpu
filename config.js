const colorFnMap = {
    confetti: () => [Math.random(), Math.random(), Math.random(), 1.0],
    blue: () => [0, 0, 1., 1.0],
    red: () => [1., 0, 0, 1.0],
    green: () => [0, 1., 0, 1.0],
    grey: () => {const v = Math.random(); return [v, v, v, 1.0]}
};

// Tunables!
const defaults = {
    boidCount : 1000,
    colorFn: colorFnMap.confetti,
    overrides: {
        sightRadius : .04,
        protectedRadius: .03,
        wall : 1.05,
        sepFactor : .001,
        alignFactor : .3,
        cohesionFactor : .001,
        edgeFactor : .0001,
        minSpeed : .010,
        speedUp : 1.01, // if below minSpeed, accelerate by speedUp
        pointerRadius : .2,
        pointerPush : .002,
        maxSpeed : 1.
    }
};

// does not currently validate params!
const configFromQueryParams = (defaultConfig=defaults) => {
    const params = new URLSearchParams(window.location.search);

    const overrides = {};
    for(const [tunable, defaultVal] of Object.entries(defaultConfig.overrides)) {
        overrides[tunable] = params.get(tunable) || defaultVal;
    }
    
    const conf = {
        boidCount : params.get("count") || defaultConfig.boidCount,
        colorFn: colorFnMap[params.get("color")] || defaultConfig.colorFn,
        overrides
    };
    console.log(conf);
    return conf;
};

export { defaults, configFromQueryParams };