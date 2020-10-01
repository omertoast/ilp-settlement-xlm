import debug from 'debug'
import { AccountServices, SettlementEngine} from 'ilp-settlement-core'
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'
import StellarSdk from 'stellar-sdk'


const log = debug('settlement-xlm')

export const TESTNET_STELLAR_URL = 'https://horizon-testnet.stellar.org'

export interface XlmEngineOpts {
  xlmSecret?: string
  stellarTestnetUrl?: string
  stellarClient?: string
}

export interface XlmSettlementEngine extends SettlementEngine {
  handleMessage(accountID: string, message: any): Promise<any>
  handleTransaction(tx: any): void
  disconnect(): Promise<void>
}

export type ConnectXlmSettlementEngine = (services: AccountServices) => Promise<XlmSettlementEngine>

export const creatEngine = (opts: XlmEngineOpts = {}): ConnectXlmSettlementEngine => async ({
  sendMessage,
  creditSettlement
}) => {
  /**XLM secret for sending and signing outgoing payments */
  const xlmSecret = opts.xlmSecret || (await generateTestnetAccount())
}


/** Generate a secret for a new, prefunded XRP account */
export const generateTestnetAccount = async () => {
  const pair = StellarSdk.Keypair.random()

  try {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(
        pair.publicKey(),
      )}`,
    );
    const responseJSON = await response.json();
    console.log("SUCCESS! You have a new account :)\n", responseJSON);
    
    
  } catch (e) {
    console.error("ERROR!", e);
  }
}