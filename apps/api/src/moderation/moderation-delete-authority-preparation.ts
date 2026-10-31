const preparedAuthority = Symbol('prepared moderation delete authority');

export type PreparedDeleteAuthority<T> = Readonly<{
  [preparedAuthority]: true;
  finalize: () => Promise<T>;
  prepareLocalRecheck: () => PreparedDeleteAuthority<T>;
}>;

export type DeleteAuthorityPreparation<T> = T | PreparedDeleteAuthority<T>;
type FinalizeNestedDeleteAuthority = <T>(preparation: DeleteAuthorityPreparation<T>) => Promise<T>;

// FLAG: Preparation captures remote evidence, never permission to dispatch. Only the
// single-use local finalizer may supply authority after the transport quota wait. A failed
// final duplicate permit may request one new local capsule over the same remote evidence.
export function prepareDeleteAuthority<T>(
  finalize: (finalizeNested: FinalizeNestedDeleteAuthority) => Promise<T>,
): PreparedDeleteAuthority<T> {
  return prepareAuthorityCapsule(finalize, false);
}

function prepareAuthorityCapsule<T>(
  finalize: (finalizeNested: FinalizeNestedDeleteAuthority) => Promise<T>,
  recheck: boolean,
): PreparedDeleteAuthority<T> {
  let state: 'unused' | 'running' | 'fulfilled' | 'rejected' = 'unused';
  let recheckPrepared = recheck;
  let rejection: unknown;
  return Object.freeze({
    [preparedAuthority]: true as const,
    finalize: async () => {
      if (state !== 'unused') throw new Error('Moderation delete authority was already finalized');
      state = 'running';
      try {
        const result = await finalize(
          recheck ? finalizeDeleteAuthorityRecheck : finalizeDeleteAuthority,
        );
        state = 'fulfilled';
        return result;
      } catch (error) {
        state = 'rejected';
        rejection = error;
        throw error;
      }
    },
    prepareLocalRecheck: () => {
      if (state === 'unused' || state === 'running')
        throw new Error('Moderation delete authority has not finished finalizing');
      if (recheckPrepared) throw new Error('Moderation delete local recheck was already prepared');
      recheckPrepared = true;
      // FLAG: A nested reason rejected in the first composition never gains authority
      // from fallback. Preserve its rejection while rechecking surviving nested evidence.
      return prepareAuthorityCapsule(
        state === 'rejected'
          ? async () => {
              throw rejection;
            }
          : finalize,
        true,
      );
    },
  });
}

export function isPreparedDeleteAuthority<T>(
  value: DeleteAuthorityPreparation<T>,
): value is PreparedDeleteAuthority<T> {
  return typeof value === 'object' && value !== null && preparedAuthority in value;
}

export function prepareDeleteAuthorityRecheck<T>(
  preparation: DeleteAuthorityPreparation<T>,
): PreparedDeleteAuthority<T> {
  if (!isPreparedDeleteAuthority(preparation))
    throw new Error('Moderation delete authority has no prepared local recheck');
  return preparation.prepareLocalRecheck();
}

async function finalizeDeleteAuthorityRecheck<T>(
  preparation: DeleteAuthorityPreparation<T>,
): Promise<T> {
  return finalizeDeleteAuthority(prepareDeleteAuthorityRecheck(preparation));
}

export async function finalizeDeleteAuthority<T>(
  preparation: DeleteAuthorityPreparation<T>,
  beforeFinalAuthority?: () => Promise<void>,
): Promise<T> {
  if (!isPreparedDeleteAuthority(preparation)) return preparation;
  await beforeFinalAuthority?.();
  return preparation.finalize();
}
