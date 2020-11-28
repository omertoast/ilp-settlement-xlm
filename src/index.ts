import debug from 'debug'
import { AccountServices, SettlementEngine} from 'ilp-settlement-core'
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'
import { randomBytes } from 'crypto'
import {
  Keypair,
  Server,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Operation,
  Asset,
} from 'stellar-sdk'
import { Memo } from 'stellar-base'

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

export const createEngine = (opts: XlmEngineOpts = {}): ConnectXlmSettlementEngine => async ({
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
  const incomingPaymentMemos = new Map<string, string>()

  /** Set of timeout IDs to cleanup when exiting */
  const pendingTimers = new Set<NodeJS.Timeout>()

  const self: XlmSettlementEngine = {
    async handleMessage(accountID, message) {
      const paymentMemo = randomBytes(4).readUInt32BE(0).toString()
      if(message.type && message.type === 'paymentDetails') {
        if(incomingPaymentMemos.has(paymentMemo)) {
          throw new Error('Failed to generate new memo')
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
      const amount = queuedAmount.decimalPlaces(7, BigNumber.ROUND_DOWN) // Limit precision to drops (remainder will be refunded)
      if (amount.isZero()) {
        // Even though settlement-core checks against this, if connector scale > 7, it could still round down to 0
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

      // Ensure only a single settlement occurs at once
      if (pendingTransaction) {
        log(`Failed to settle: transaction already in progress: ${details}`)
        return new BigNumber(0)
      }
      
      // Apply lock for pending transaction
      pendingTransaction = true

      let account = await stellarClient.loadAccount(xlmAddress)
      let transactionMemo = new Memo('id', paymentDetails.paymentMemo)

      try {
        let transaction = new TransactionBuilder(account, {
          memo: transactionMemo,
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        })
        .addOperation(Operation.payment({
          destination: paymentDetails.xlmAddress,
          asset: Asset.native(),
          amount: amount.toString()
        }))
        .setTimeout(300000)
        .build()

        transaction.sign(xlmKeypair)
        await stellarClient.submitTransaction(transaction)
        return amount
      } catch(err) {
        log(`Failed to settle: Transaction error: ${details}`, err)
        return amount // For safety, assume transaction was applied (return full amount was settled)
      } finally {
        pendingTransaction = false
      }
    },
    
    async handleTransaction(txResponse) {
      if (txResponse.to !== xlmAddress) {
        return
      }

      const amount = new BigNumber(txResponse.amount)
      if (!amount.isGreaterThan(0)) {
        return
      }

      // TODO What if amount is NaN? (Will settlement-core catch that?)

      let txTransaction = await stellarClient.transactions()
        .transaction(txResponse.transaction_hash)
        .call()

      if(!txTransaction.memo) {
        return
      }

      const accountId = incomingPaymentMemos.get(txTransaction.memo)
      if(!accountId) {
        return
      }

      const txHash = txResponse.transaction_hash

      log(`Received incoming XLM payment: xlm=${amount} account=${accountId} txHash=${txHash}`)
      creditSettlement(accountId, amount, txResponse)
    },
    
    async disconnect() {
      pendingTimers.forEach(timer => clearTimeout(timer))
      paymentStream()
    }
  }

  const paymentStream = stellarClient.payments()
    .forAccount(xlmAddress)
    .cursor('now')
    .stream({onmessage: self.handleTransaction})

  return self
}


/** Generate a secret for a new, prefunded XLM account */
export const generateTestnetAccount = async () => {
  const pair = Keypair.random()

  try {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(
        pair.publicKey(),
      )}`,
    );
    const responseJSON = await response.json();

    log(`Generated new XLM testnet account: address=${pair.publicKey()} secret=${pair.secret()}`)
    return pair.secret()
  } catch (e) {
    throw new Error('Failed to generate new XLM testnet account.')
  }
}

export interface PaymentDetails {
  xlmAddress: string
  paymentMemo: string
}

// TODO: Extend max memo limit to 64-bit integer
const MAX_UINT_32 = 4294967295

export const isPaymentDetails = (o: any): o is PaymentDetails =>
  typeof o === 'object' &&
  typeof o.xlmAddress === 'string' &&
  typeof o.paymentMemo === 'string' &&
  Number(o.paymentMemo) >= 0 &&
  Number(o.paymentMemo) <= MAX_UINT_32

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

//**Convert an XLM secret to an XLM address */
export const secretToAddress = (secret: string) => Keypair.fromSecret(secret).publicKey()