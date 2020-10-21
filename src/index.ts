import debug from 'debug'
import { AccountServices, SettlementEngine} from 'ilp-settlement-core'
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'
import {
  Account,
  Keypair,
  Server,
  AccountResponse,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Operation,
  Asset,
  Horizon
} from 'stellar-sdk'
import { Memo } from 'stellar-base'
import { randomBytes } from 'crypto'

const log = debug('settlement-xlm')

export const TESTNET_STELLAR_URL = 'https://horizon-testnet.stellar.org'

export interface XlmEngineOpts {
  xlmSecret?: string
  stellarTestnetUrl?: string
  stellarClient?: Server
}

export interface XlmSettlementEngine extends SettlementEngine {
  handleMessage(accountID: string, message: any): Promise<any>
  settle(accountID: string, amount: BigNumber): Promise<any>
  handleTransaction(tx: any): void
  disconnect(): Promise<void>
}

export type ConnectXlmSettlementEngine = (services: AccountServices) => Promise<XlmSettlementEngine>


export const creatEngine = (opts: XlmEngineOpts = {}): ConnectXlmSettlementEngine => async ({
  sendMessage,
  creditSettlement
}) => {
  /** Generate XLM keypair */

  const xlmSecret = opts.xlmSecret || (await generateTestnetAccount())
  
  /** Assign XLM keypair variables seperately to use in the future processes */
  const xlmKeypair = Keypair.fromSecret(xlmSecret)
  
  const xlmAddress = xlmKeypair.publicKey()

  /** Lock if a transaction is currently being submitted */
  let pendingTransaction = false

  const stellarClient = opts.stellarClient || new Server(opts.stellarTestnetUrl || TESTNET_STELLAR_URL)

  /** Mapping of memo -> accountId to correlate incoming payments */
  const incomingPaymentMemos = new Map<Memo, string>()

  /** Set of timeout IDs to cleanup when exiting */
  const pendingTimers = new Set<NodeJS.Timeout>()

  const self: XlmSettlementEngine = {
    async handleMessage(accountID, message) {
      /** This number generator is too stupid but i'm not too clever either, TODO change it later hehe */
      const paymentMemo = new Memo('id', Date.now().toString()) 
      if(message.type && message.type === 'paymentDetails') {
        if(incomingPaymentMemos.has(paymentMemo)) {
          throw new Error('Failed to generate new destination tag')
        }

        incomingPaymentMemos.set(paymentMemo, accountID)

        //Clean up tags after 5 mins to prevent memory leak
        pendingTimers.add(setTimeout(() => incomingPaymentMemos.delete(paymentMemo), 5 * 60000))
        
        return {
          paymentMemo,
          xlmAddress
        }
      } else {
        throw new Error('Unknown message type')
      }
    },

    async settle(accountID, queuedAmount) {
      const amount = queuedAmount.decimalPlaces(6, BigNumber.ROUND_DOWN) // Limit precision to drops (remainder will be refunded)
      if (amount.isZero()) {
        // Even though settlement-core checks against this, if connector scale > 6, it could still round down to 0
        return new BigNumber(0)
      }
      let details = `account=${accountID} xlm= ${amount}`
      log(`Starting settlement: ${details}`)

      const paymentDetails = await sendMessage(accountID, {
        type: 'paymentDetails'
      })
        .then(response =>
          isPaymentDetails(response)
          ? response
          : log (`Failed to settle: Recieved invalid payment details: ${details}`)
        )
        .catch(err => log(`Failed to settle: Error fetching payment details: ${details}`, err))
      if (!paymentDetails){
        return new BigNumber(0)
      }
      
      let account = await stellarClient.loadAccount(xlmAddress)

      let transaction: any
      try {
        let transaction = new TransactionBuilder(account,{
          memo: paymentDetails.paymentMemo,
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        })
        .addOperation(Operation.payment({
          destination: paymentDetails.xlmAddress,
          asset: Asset.native(),
          amount: amount.toString()
        }))
        .setTimeout(0)
        .build()
      } catch(err) {
        log(`Failed to settle: Error preparing XLM payment ${details}`, err)
        return new BigNumber(0)
      }

      // Ensure only a single settlement occurs at once
      if (pendingTransaction) {
        log(`Failed to settle: transaction already in progress: ${details}`)
        return new BigNumber(0)
      }
      // Apply lock for pending transaction
      pendingTransaction = true

      try {
        let singedTransaction = transaction.sign(xlmKeypair)

        await stellarClient.submitTransaction(singedTransaction)
        amount : new BigNumber(0)
      } catch(err) {
        log(`Failed to settle: Transaction error: ${details}`, err)
        return amount // For safety, assume transaction was applied (return full amount was settled)
      } finally {
        pendingTransaction = false
      }
    },
    
    async handleTransaction(txResponse) {
      txResponse. 
      
      const accountId = incomingPaymentMemos.get(txResponse.Memo)
      if (!accountId) {
        return
      }
      
      const txHash = txResponse.
      creditSettlement(accountId, amount, txResponse)
    },
    
    async disconnect() {
      
    }
  }

  stellarClient.payments()
    .forAccount(xlmAddress)
    .cursor('now')
    .stream({onmessage: self.handleTransaction})

  return self
}


/** Generate a secret for a new, prefunded XRP account */
export const generateTestnetAccount = async () => {
  const pair = Keypair.random()

  try {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(
        pair.publicKey(),
      )}`,
    );
    const responseJSON = await response.json();
    console.log("SUCCESS! You have a new account :)\n", responseJSON);

    return pair.secret()
  } catch (e) {
    throw new Error('Failed to generate new XRP testnet account.')
  }
}

export interface PaymentDetails {
  xlmAddress: string
  paymentMemo: Memo
}

/** These requirements are not enough probably */
export const isPaymentDetails = (o: any): o is PaymentDetails =>
  typeof o === 'object' &&
  typeof o.xlmAddress === 'string' &&
  typeof o.paymentMemo.value === 'string' 
