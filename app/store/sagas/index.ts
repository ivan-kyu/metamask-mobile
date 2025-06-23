import { fork, take, cancel, put, call, all, select } from 'redux-saga/effects';
import NavigationService from '../../core/NavigationService';
import Routes from '../../constants/navigation/Routes';
import {
  AuthSuccessAction,
  AuthErrorAction,
  InterruptBiometricsAction,
  lockApp,
  setAppServicesReady,
  UserActionType,
  LoginAction,
  CheckForDeeplinkAction,
  checkForDeeplink,
} from '../../actions/user';
import { NavigationActionType } from '../../actions/navigation';
import { Task } from 'redux-saga';
import Engine from '../../core/Engine';
import Logger from '../../util/Logger';
import LockManagerService from '../../core/LockManagerService';
import {
  overrideXMLHttpRequest,
  restoreXMLHttpRequest,
} from './xmlHttpRequestOverride';
import EngineService from '../../core/EngineService';
import { AppStateEventProcessor } from '../../core/AppStateEventListener';
import AccountTreeInitService from '../../multichain-accounts/AccountTreeInitService';
import SharedDeeplinkManager from '../../core/DeeplinkManager/SharedDeeplinkManager';
import AppConstants from '../../core/AppConstants';
import {
  SET_COMPLETED_ONBOARDING,
  SetCompletedOnboardingAction,
} from '../../actions/onboarding';
import { selectCompletedOnboarding } from '../../selectors/onboarding';
import { selectUserLoggedIn } from '../../reducers/user';
import branch from 'react-native-branch';
import SDKConnect from '../../core/SDKConnect/SDKConnect';
import WC2Manager, { isWC2Enabled } from '../../core/WalletConnect/WalletConnectV2';
import { store } from '../../store';
import { DevLogger } from '../../core/SDKConnect/utils/DevLogger';
import StorageWrapper from '../../store/storage-wrapper';
import { EXISTING_USER } from '../../constants/storage';
import { Linking } from 'react-native';
import Device from '../../util/device';

export function* appLockStateMachine() {
  let biometricsListenerTask: Task<void> | undefined;
  while (true) {
    yield take(UserActionType.LOCKED_APP);
    if (biometricsListenerTask) {
      yield cancel(biometricsListenerTask);
    }
    const bioStateMachineId = Date.now().toString();
    biometricsListenerTask = yield fork(
      biometricsStateMachine,
      bioStateMachineId,
    );
    NavigationService.navigation?.navigate(Routes.LOCK_SCREEN, {
      bioStateMachineId,
    });
  }
}

/**
 * The state machine for detecting when the app is logged vs logged out.
 * While on the Wallet screen, this state machine
 * will "listen" to the app lock state machine.
 */
export function* authStateMachine() {
  // Start when the user is logged in.
  while (true) {
    yield take(UserActionType.LOGIN);
    const appLockStateMachineTask: Task<void> = yield fork(appLockStateMachine);
    LockManagerService.startListening();
    //TODO: Move this logic to the Engine when the account tree state will be persisted
    AccountTreeInitService.initializeAccountTree();
    // Listen to app lock behavior.
    yield take(UserActionType.LOGOUT);
    LockManagerService.stopListening();
    // Cancels appLockStateMachineTask, which also cancels nested sagas once logged out.
    yield cancel(appLockStateMachineTask);
  }
}

/**
 * Locks the KeyringController and dispatches LOCK_APP.
 */
export function* lockKeyringAndApp() {
  const { KeyringController } = Engine.context;
  try {
    yield call(KeyringController.setLocked);
  } catch (e) {
    Logger.log('Failed to lock KeyringController', e);
  }
  yield put(lockApp());
}

/**
 * The state machine, which is responsible for handling the state
 * changes related to biometrics authentication.
 */
export function* biometricsStateMachine(originalBioStateMachineId: string) {
  // This state machine is only good for a one time use. After it's finished, it relies on LOCKED_APP to restart it.
  // Handle next three possible states.
  let shouldHandleAction = false;
  let action:
    | AuthSuccessAction
    | AuthErrorAction
    | InterruptBiometricsAction
    | undefined;

  // Only continue on INTERRUPT_BIOMETRICS action or when actions originated from corresponding state machine.
  while (!shouldHandleAction) {
    action = yield take([
      UserActionType.AUTH_SUCCESS,
      UserActionType.AUTH_ERROR,
      UserActionType.INTERRUPT_BIOMETRICS,
    ]);
    if (
      action?.type === UserActionType.INTERRUPT_BIOMETRICS ||
      action?.payload?.bioStateMachineId === originalBioStateMachineId
    ) {
      shouldHandleAction = true;
    }
  }

  if (action?.type === UserActionType.INTERRUPT_BIOMETRICS) {
    // Biometrics was most likely interrupted during authentication with a non-zero lock timer.
    yield fork(lockKeyringAndApp);
  } else if (action?.type === UserActionType.AUTH_ERROR) {
    // Authentication service will automatically log out.
  } else if (action?.type === UserActionType.AUTH_SUCCESS) {
    // Authentication successful. Navigate to wallet.
    NavigationService.navigation?.navigate(Routes.ONBOARDING.HOME_NAV);
  }
}

export function* basicFunctionalityToggle() {
  while (true) {
    const { basicFunctionalityEnabled } = yield take(
      'TOGGLE_BASIC_FUNCTIONALITY',
    );

    if (basicFunctionalityEnabled) {
      restoreXMLHttpRequest();
    } else {
      // apply global blocklist
      overrideXMLHttpRequest();
    }
  }
}

export function* handleDeeplinkSaga() {
  while (true) {
    // Handle parsing deeplinks after login or when the lock manager is resolved
    const value = (yield take([
      UserActionType.LOGIN,
      UserActionType.CHECK_FOR_DEEPLINK,
      SET_COMPLETED_ONBOARDING,
    ])) as LoginAction | CheckForDeeplinkAction | SetCompletedOnboardingAction;

    let completedOnboarding = false;

    // Check if triggering action is SET_COMPLETED_ONBOARDING
    if (value.type === SET_COMPLETED_ONBOARDING) {
      completedOnboarding = value.completedOnboarding;
    } else {
      completedOnboarding = yield select(selectCompletedOnboarding);
    }

    const { KeyringController } = Engine.context;
    const isUnlocked = KeyringController.isUnlocked();

    // App is locked or onboarding is not yet complete
    if (!isUnlocked || !completedOnboarding) {
      continue;
    }

    const deeplink = AppStateEventProcessor.pendingDeeplink;
    if (deeplink) {
      // TODO: See if we can hook into a navigation finished event before parsing so that the modal doesn't conflict with ongoing navigation events
      setTimeout(() => {
        SharedDeeplinkManager.parse(deeplink, {
          origin: AppConstants.DEEPLINKS.ORIGIN_DEEPLINK,
        });
      }, 200);
      AppStateEventProcessor.clearPendingDeeplink();
    }
  }
}

type DeepLinkQueuedItem = {
  uri: string;
  func: () => void;
}

type SDKInitState = {
  isInitialized: boolean;
}

/**
 * Initializes deeplink handling and URL processing
 */
function* handleInitialDeeplink(
  queueOfHandleDeeplinkFunctions: DeepLinkQueuedItem[],
  sdkState: SDKInitState,
) {
  // Subscribe to incoming deeplinks
  // Branch.io documentation: https://help.branch.io/developers-hub/docs/react-native
  const handleDeeplink = (opts: {
   // error?: string | null;
      // params?: Record<string, unknown>;
    uri?: string;
  }) => {
    const { dispatch } = store;
    const {uri} = opts;
    // if (error) {
    //   trackErrorAsAnalytics(error, 'Branch:');
    // }
    // const deeplink = params?.['+non_branch_link'] || uri || null;
    try {
      if (uri && typeof uri === 'string') {
        AppStateEventProcessor.setCurrentDeeplink(uri);
        dispatch(checkForDeeplink());
      }
    } catch (e) {
      Logger.error(e as Error, `Deeplink: Error parsing deeplink`);
    }
  };

  const handleURL = (url: string) => {
    if (url && sdkState.isInitialized) {
      handleDeeplink({ uri: url });
    } else {
      DevLogger.log(`android handleDeeplink:: adding ${url} to queue`);
      queueOfHandleDeeplinkFunctions.push({
        uri: url,
        func: () => {
          handleDeeplink({ uri: url });
        },
      });
    }
  };

  Linking.getInitialURL().then((url) => {
    if (!url) {
      return;
    }
    DevLogger.log(`handleDeeplink:: got initial URL ${url}`);
    handleURL(url);
  });

  if (Device.isAndroid()) {
    Linking.addEventListener('url', (params) => {
      const { url } = params;
      handleURL(url);
    });
  }

  return { handleDeeplink, handleURL };
}

/**
 * Initializes SharedDeeplinkManager and branch subscription
 */
function* handleSharedDeeplinkManager(
  queueOfHandleDeeplinkFunctions: DeepLinkQueuedItem[],
  sdkState: SDKInitState,
  handleDeeplink: (opts: any) => void
) {
  try {
    //TODO: Migrate to the right type
    SharedDeeplinkManager.init({
      navigation: NavigationService.navigation as any,
      dispatch: store.dispatch,
    });
    // Subscribe to branch deeplinks
    branch.subscribe((opts) => {
      const { error } = opts;
      if (error) {
        const branchError = new Error(error);
        Logger.error(branchError, 'Error subscribing to branch.');
      }
      branch.getLatestReferringParams().then((val) => {
        const deeplink = opts.uri || (val['+non_branch_link'] as string);
        handleDeeplink({ uri: deeplink });
      });
      if (sdkState.isInitialized) {
        handleDeeplink(opts);
      } else if (opts.uri) {
        queueOfHandleDeeplinkFunctions.push({
          uri: opts.uri,
          func: () => {
            handleDeeplink(opts);
          },
        });
      }
    });
  } catch (error) {
    Logger.error(error as Error, 'Error initializing SharedDeeplinkManager');
  }
}

/**
 * Initializes SDKConnect when user is onboarded and logged in
 */
function* handleSDKConnect(queueOfHandleDeeplinkFunctions: DeepLinkQueuedItem[], sdkState: SDKInitState) {
  try {
    // Check if user is onboarded
    const existingUser: string | null = yield call(StorageWrapper.getItem, EXISTING_USER);
    const userLoggedIn: boolean = yield select(selectUserLoggedIn);
    if (existingUser !== null && userLoggedIn) {
      try {
        const sdkConnect = SDKConnect.getInstance();
        yield call([sdkConnect, 'init'], {
          context: 'Nav/App',
          navigation: NavigationService.navigation,
        });

        // Call postInit
        yield call([sdkConnect, 'postInit'], () => {
          const processedItems = new Set<string>();
          while(queueOfHandleDeeplinkFunctions.length) {
            const [deeplinkFunction] = queueOfHandleDeeplinkFunctions.splice(0, 1);

            if (deeplinkFunction && !processedItems.has(deeplinkFunction.uri)) {
              processedItems.add(deeplinkFunction.uri);
              deeplinkFunction.func();
            }
          }
        });

        // Update the shared state
        sdkState.isInitialized = true;
        Logger.log('SDKConnect initialized successfully in saga');
      } catch (err) {
        Logger.error(err as Error, 'Cannot initialize SDKConnect in saga');
      }
    }
  } catch (error) {
    Logger.error(error as Error, 'Error checking user status for SDKConnect initialization');
  }
}

/**
 * Initializes WalletConnect v2 Manager
 */
function* handleWC2Manager() {
  if (isWC2Enabled) {
    try {
      DevLogger.log(`WalletConnect: Initializing WalletConnect Manager in saga`);
      yield call(WC2Manager.init, { navigation: NavigationService.navigation });
    } catch (err) {
      Logger.error(err as Error, 'Cannot initialize WalletConnect Manager in saga');
    }
  }
}

export function* handleDeeplinkServiceInitialization() {
  const queueOfHandleDeeplinkFunctions: DeepLinkQueuedItem[] = [];
  const sdkState: SDKInitState = { isInitialized: false };

  const { handleDeeplink } = yield call(
    handleInitialDeeplink,
    queueOfHandleDeeplinkFunctions,
    sdkState
  );

  yield call(
    handleSharedDeeplinkManager,
    queueOfHandleDeeplinkFunctions,
    sdkState,
    handleDeeplink
  );

  yield call(
    handleSDKConnect,
    queueOfHandleDeeplinkFunctions,
    sdkState
  );
  yield call(handleWC2Manager);
}

/**
 * Handles initializing app services on start up
 */
export function* startAppServices() {
  // Wait for persisted data to be loaded and navigation to be ready
  yield all([
    take(UserActionType.ON_PERSISTED_DATA_LOADED),
    take(NavigationActionType.ON_NAVIGATION_READY),
  ]);

  yield call(handleDeeplinkServiceInitialization);

  // Start Engine service
  yield call(EngineService.start);

  // Start AppStateEventProcessor
  AppStateEventProcessor.start();

  // Unblock the ControllersGate
  yield put(setAppServicesReady());
}

// Main generator function that initializes other sagas in parallel.
export function* rootSaga() {
  yield fork(startAppServices);
  yield fork(authStateMachine);
  yield fork(basicFunctionalityToggle);
  yield fork(handleDeeplinkSaga);
}
