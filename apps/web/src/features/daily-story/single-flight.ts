export function runSingleFlight<TResult>(
  ref: { current: Promise<TResult> | null },
  task: () => Promise<TResult>,
) {
  if (ref.current) return ref.current;
  const promise = Promise.resolve()
    .then(task)
    .finally(() => {
      if (ref.current === promise) ref.current = null;
    });
  ref.current = promise;
  return promise;
}
