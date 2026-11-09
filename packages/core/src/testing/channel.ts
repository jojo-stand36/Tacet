/** Minimal single-consumer async queue used by test adapters. */
export class Channel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((r: IteratorResult<T>) => void) | undefined;
  #ended = false;

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
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
