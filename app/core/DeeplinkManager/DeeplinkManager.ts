'use strict';

import { NavigationContainerRef } from '@react-navigation/native';
import { ParseOutput } from 'eth-url-parser';
import { Dispatch } from 'redux';
import handleBrowserUrl from './Handlers/handleBrowserUrl';
import handleEthereumUrl from './Handlers/handleEthereumUrl';
import handleRampUrl from './Handlers/handleRampUrl';
import switchNetwork from './Handlers/switchNetwork';
import parseDeeplink from './ParseManager/parseDeeplink';
import approveTransaction from './TransactionManager/approveTransaction';
import { RampType } from '../../reducers/fiatOrders/types';
import { handleSwapUrl } from './Handlers/handleSwapUrl';
import Routes from '../../constants/navigation/Routes';
import NavigationService from '../NavigationService';
import { store } from '../../store';
import branch from 'react-native-branch';
import Logger from '../../util/Logger';
import { AppStateEventProcessor } from '../AppStateEventListener';
import { checkForDeeplink } from '../../actions/user';
import { Linking } from 'react-native';
import Device from '../../util/device';

class DeeplinkManager {
  public navigation: NavigationContainerRef;
  public pendingDeeplink: string | null;
  // TODO: Replace "any" with type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public dispatch: Dispatch<any>;

  constructor() {
    const navigation = NavigationService.navigation;
    const dispatch = store.dispatch;
    this.navigation = navigation;
    this.pendingDeeplink = null;
    this.dispatch = dispatch;
  }

  private  handleDeeplink(opts: {
     uri?: string;
   }) {
    const { dispatch } = store;
    const {uri} = opts;
    try {
      if (uri && typeof uri === 'string') {
        AppStateEventProcessor.setCurrentDeeplink(uri);
        dispatch(checkForDeeplink());
      }
    } catch (e) {
      Logger.error(e as Error, `Deeplink: Error parsing deeplink`);
    }
  }

   start() {
    //TODO: This function seems to me like a little risky
    //getInitialURL and getLastReferringParams are async functions
    //and won't be able to capture the error
    //and end up having an un caught exception error
    Linking.getInitialURL().then((url) => {
      if (!url) {
        return;
      }
      Logger.log(`handleDeeplink:: got initial URL ${url}`);
      this.handleDeeplink({ uri: url });
    });
    if (Device.isAndroid()) {
      Linking.addEventListener('url', (params) => {
        const { url } = params;
        this.handleDeeplink({ uri: url });
      });
    }
    branch.subscribe((opts) => {
      const { error } = opts;
      if (error) {
        const branchError = new Error(error);
        Logger.error(branchError, 'Error subscribing to branch.');
      }
      //TODO: that async call in the subscribe doesn't look good to me
      branch.getLatestReferringParams().then((val) => {
        const deeplink = opts.uri || (val['+non_branch_link'] as string);
        this.handleDeeplink({ uri: deeplink });
      });
      this.handleDeeplink(opts);
    });
  }

  setDeeplink = (url: string) => (this.pendingDeeplink = url);

  getPendingDeeplink = () => this.pendingDeeplink;

  expireDeeplink = () => (this.pendingDeeplink = null);

  /**
   * Method in charge of changing network if is needed
   *
   * @param switchToChainId - Corresponding chain id for new network
   */
  _handleNetworkSwitch = (switchToChainId: `${number}` | undefined) =>
    switchNetwork({
      deeplinkManager: this,
      switchToChainId,
    });

  _approveTransaction = async (ethUrl: ParseOutput, origin: string) =>
    approveTransaction({
      deeplinkManager: this,
      ethUrl,
      origin,
    });

  async _handleEthereumUrl(url: string, origin: string) {
    return handleEthereumUrl({
      deeplinkManager: this,
      url,
      origin,
    });
  }

  _handleBrowserUrl(url: string, callback?: (url: string) => void) {
    return handleBrowserUrl({
      deeplinkManager: this,
      url,
      callback,
    });
  }

  _handleBuyCrypto(rampPath: string) {
    handleRampUrl({
      rampPath,
      rampType: RampType.BUY,
    });
  }

  _handleSellCrypto(rampPath: string) {
    handleRampUrl({
      rampPath,
      rampType: RampType.SELL,
    });
  }

  // NOTE: open the home screen for new subdomain
  _handleOpenHome() {
    this.navigation.navigate(Routes.WALLET.HOME);
  }

  // NOTE: this will be used for new deeplink subdomain
  _handleSwap(swapPath: string) {
    handleSwapUrl({
      swapPath,
    });
  }
  // NOTE: keeping this for backwards compatibility
  _handleOpenSwap() {
    this.navigation.navigate(Routes.SWAPS);
  }

  async parse(
    url: string,
    {
      browserCallBack,
      origin,
      onHandled,
    }: {
      browserCallBack?: (url: string) => void;
      origin: string;
      onHandled?: () => void;
    },
  ) {
    return await parseDeeplink({
      deeplinkManager: this,
      url,
      origin,
      browserCallBack,
      onHandled,
    });
  }
}

export default DeeplinkManager;
