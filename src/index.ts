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
import { randomBytes } from 'crypto'

const log = debug('settlement-xlm')

export const TESTNET_STELLAR_URL = 'https://horizon-testnet.stellar.org'

export interface XlmEngineOpts {
  xlmSecret?: string
  stellarTestnetUrl?: string
  stellarClient?: string
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
  const pair = Keypair.fromSecret(opts.xlmSecret) || (await generateTestnetAccount())

  /** Assign XLM keypair variables seperately to use in the future processes */
  let xlmKeypair = pair
  let xlmSecret = xlmKeypair.secretKey()
  let xlmAddress = xlmKeypair.publicKey()

  /** Lock if a transaction is currently being submitted */
  let pendingTransaction = false

  const stellarClient = new Server("https://horizon-testnet.stellar.org")

  /** Mapping of destinationTag -> accountId to correlate incoming payments */
  const incomingPaymentTags = new Map<number, string>()

  /** Set of timeout IDs to cleanup when exiting */
  const pendingTimers = new Set<NodeJS.Timeout>()

  const self: XlmSettlementEngine = {
    async handleMessage(accountID, message) {
      if(message.type && message.type === 'paymentDetails') {
        const destinationTag = randomBytes(4).readUInt32BE(0)
        if(incomingPaymentTags.has(destinationTag)) {
          throw new Error('Failed to generate new destination tag')
        }

        incomingPaymentTags.set(destinationTag, accountID)

        //Clean up tags after 5 mins to prevent memory leak
        pendingTimers.add(setTimeout(() => incomingPaymentTags.delete(destinationTag), 5 * 60000))
        
        return {
          destinationTag,
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
          fee: BASE_FEE,
          networkPassphrase = Networks.TESTNET
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
      }
    }
  }
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

    return pair
  } catch (e) {
    console.error("ERROR!", e);
  }
}

export interface PaymentDetails {
  xlmAddress: string
  destinationTag: number
}

const MAX_UINT_32 = 4294967295

export const isPaymentDetails = (o: any): o is PaymentDetails =>
  typeof o === 'object' &&
  typeof o.xlmAddress === 'string' &&
  Number.isInteger(o.destinationTag) &&
  o.destinationTag >= 0 &&
  o.destinationTag <= MAX_UINT_32