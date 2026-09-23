export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string, code?: string): never => {
  throw new HttpError(status, message, code);
};
