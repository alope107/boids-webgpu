const loadFiles = async (...paths) => {
    return Promise.all(paths.map(
            async (path) => {
                const resp = await fetch(path);
                if(!resp.ok) throw new Error(`failed to load shader code from ${path}`);
                return resp.text();
    }));
};

export default loadFiles;