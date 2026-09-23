import { createContext, useContext } from 'react';

/** Static/demo surfaces must never resolve fixture identities against a live daemon. */
const ProfileImageNetworkContext = createContext(true);
export const ProfileImageNetworkProvider = ProfileImageNetworkContext.Provider;
export const useProfileImageNetworkEnabled = () => useContext(ProfileImageNetworkContext);
