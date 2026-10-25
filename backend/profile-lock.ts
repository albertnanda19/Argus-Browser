export type ProfileLock = {
  run<T>(profileId: string, task: () => Promise<T>): Promise<T>;
};

export function createProfileLock(): ProfileLock {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run<T>(profileId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(profileId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(task);
      tails.set(profileId, current);

      void current.then(
        () => {
          if (tails.get(profileId) === current) {
            tails.delete(profileId);
          }
        },
        () => {
          if (tails.get(profileId) === current) {
            tails.delete(profileId);
          }
        },
      );

      return current;
    },
  };
}
