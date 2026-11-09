export const ECONOME_FEATURE = 'econome';

export interface Access {
  featuresOf: (uid: string) => Promise<string[]>;
}

export class AccessError extends Error {}

export const requireFeature = async (access: Access, uid: string, feature: string) => {
  if ((await access.featuresOf(uid)).includes(feature)) return;
  throw new AccessError(
    `This account isn't allowed to use Économe yet. Ask whoever manages access to add the "${feature}" feature to its access record.`,
  );
};
