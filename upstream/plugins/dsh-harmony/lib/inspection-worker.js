import { parentPort } from 'node:worker_threads';
import { executeParallelInspectionTask, } from './runtime.js';
if (parentPort === null)
    throw new Error('dsh-harmony: inspection worker requires a parent port');
parentPort.on('message', ({ id, task }) => {
    let response;
    try {
        response = { id, result: executeParallelInspectionTask(task) };
    }
    catch (error) {
        response = {
            id,
            error: {
                name: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
            },
        };
    }
    parentPort.postMessage(response);
});
