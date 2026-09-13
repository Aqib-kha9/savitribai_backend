import { randomUUID } from 'node:crypto';
export function requestId(request, response, next) {
    const id = request.header('x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', id);
    next();
}
