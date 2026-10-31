export class DocumentFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
