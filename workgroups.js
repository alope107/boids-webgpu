const dispatchCount = (desiredThreads, workgroupSize) => {
    return Math.ceil(desiredThreads/
            workgroupSize.reduce((product, dim) => product * dim, 1));
};

export default dispatchCount;