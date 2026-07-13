// I'm not sure this value is meant to be used the way I use it...
// Something something dispatch dimension???

const dispatchCount = (desiredThreads, workgroupSize) => {
    return Math.ceil(desiredThreads/
            workgroupSize.reduce((product, dim) => product * dim, 1));
};

export default dispatchCount;