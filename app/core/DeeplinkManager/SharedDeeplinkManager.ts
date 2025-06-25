import DevLogger from '../SDKConnect/utils/DevLogger';
import DeeplinkManager from './DeeplinkManager';

let instance: DeeplinkManager;

//TODO: This doesn't seem like needed to me, we could be just using DeeplinkManager directly
const SharedDeeplinkManager = {
  getInstance: () => instance,
  init: () => {
    if (instance) {
      return;
    }
    instance = new DeeplinkManager();
    DevLogger.log(`DeeplinkManager initialized`);
  },
  parse: (
    url: string,
    args: {
      browserCallBack?: (url: string) => void;
      origin: string;
      onHandled?: () => void;
    },
  ) => instance.parse(url, args),
  setDeeplink: (url: string) => instance.setDeeplink(url),
  getPendingDeeplink: () => instance.getPendingDeeplink(),
  expireDeeplink: () => instance.expireDeeplink(),
  start: () => instance.start(),
};

export default SharedDeeplinkManager;
