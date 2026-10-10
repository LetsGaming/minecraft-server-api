import { EventEmitter } from "events";

export class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = (): boolean => true;

  emitOut(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  emitErr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  close(code: number | null): void {
    this.emit("close", code);
  }
}
