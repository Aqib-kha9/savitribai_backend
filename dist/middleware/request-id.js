import { randomUUID } from 'node:crypto';
export function requestId(request, response, next) {
    const id = request.header('x-request-id') ?? randomUUID();
    request.id = id;
    response.setHeader('x-request-id', id);
    next();
}
