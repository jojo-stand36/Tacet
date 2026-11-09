/** Single-consumer async queue: the SDK's streaming-input inbox and each session's event stream. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((r: IteratorResult<T>) => void) | undefined;
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiting;
    if (waiter) {
      this.#waiting = undefined;
      waiter({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    this.#ended = true;
    const waiter = this.#waiting;
    this.#waiting = undefined;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift() as T, done: false });
        }
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
