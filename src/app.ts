import * as config from 'config'
import { Api, JsonRpc } from 'eosjs'
import { JsSignatureProvider } from 'eosjs/dist/eosjs-jssig'
import * as _ from 'lodash'
import { logger, slack } from './common'
import version from './version'

const fetch = require('node-fetch')
const util = require('util')
const textEncoder = new util.TextEncoder()
const textDecoder = new util.TextDecoder()

const signatureProvider = new JsSignatureProvider([config.get('regproducer_key')])
const rpc = new JsonRpc(config.get('api'), { fetch })
const eos = new Api({
  rpc,
  signatureProvider,
  textDecoder,
  textEncoder,
})

const producer_accounts: string[] = config.get('producer_accounts')
const producer_permission: string = config.get('producer_permission')
const producer_website: string = config.get('producer_website')
const producer_location: number = config.get('producer_location')
let producer_signing_pubkeys_nodes: string[][] = (config.get('producer_signing_pubkeys_nodes') as string[][]).slice()

const rounds_missed_threshold: number = config.has('rounds_missed_threshold') ? config.get('rounds_missed_threshold') : 1
const total_producers: number = config.has('total_producers') ? config.get('total_producers') : 21
const round_timer: number = (config.has('round_timer') ? Number(config.get('round_timer')) : 126) * 1000

let stuck_counter = 0

const producersTracking: any = _.map(producer_accounts, (producer_account) => {
  return {
    rounds_missed: 0,
    last_unpaid: -1,
    producer_account
  }
})

function throttle(num: number): boolean {
  const sqrt = Math.floor(Math.pow(num, 0.5))
  return num === sqrt * sqrt
}

export async function getChainState(): Promise<any> {
  try {
    const info = await rpc.get_info()
    return _.pick(info, [
      'head_block_num',
      'head_block_producer'
    ])
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve chain state')
      slack.send(`⚠️ Unable to get_info ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_info`)
    }
    return false
  }
}

export async function getActiveProducers(): Promise<any> {
  try {
    const results = await rpc.get_producers(true, '', total_producers)
    return { ...results.rows }
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve active producers')
      slack.send(`⚠️ Unable to retrieve active producers ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_producers`)
    }
    return false
  }
}

export async function getProducerSchedule(): Promise<any> {
  try {
    const results = await rpc.get_producer_schedule()
    return results
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve producer schedule')
      slack.send(`⚠️ Unable to retrieve producer schedule ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_producer_schedule`)
    }
    return false
  }
}

export function incomingSigningKeyChange(
  producerTracking: any,
  current_signing_key: string,
  schedule: any,
  state: string
): boolean {
  if (schedule[state] && schedule[state].producers) {
    const schedule_for_producer = _.find(schedule[state].producers, { producer_name: producerTracking.producer_account })
    if (schedule_for_producer) {
      const scheduled_new_key = schedule_for_producer.block_signing_key
      if (undefined !== producer_signing_pubkeys_nodes.find((producer_signing_pubkeys) => producer_signing_pubkeys.includes(scheduled_new_key))) {
        logger.debug({ producer_signing_pubkeys_nodes, current_signing_key }, `removing ${state} producer key from potential failover keys`)
        producer_signing_pubkeys_nodes = _.filter(producer_signing_pubkeys_nodes, (producer_signing_pubkeys) => !producer_signing_pubkeys.includes(scheduled_new_key))
      }
      if (scheduled_new_key !== current_signing_key) {
        logger.debug({ scheduled_new_key, current_signing_key }, `${state} schedule change found, awaiting...`)
        return true
      }
    }
  }
  return false
}

export async function failover(producer_account: string, next_signing_key: string): Promise<string> {
  const result = await eos.transact({
    actions: [
      {
        authorization: [{
          actor: producer_account,
          permission: producer_permission,
        }],
        account: 'eosio',
        name: 'regproducer',
        data: {
          location: producer_location,
          producer: producer_account,
          producer_key: next_signing_key,
          url: producer_website,
        },
      }
    ]
  }, {
    blocksBehind: 3,
    expireSeconds: 60,
  })
  return result.transaction_id
}

async function checkProducer(producerTracking: any, state: any, producers: any, schedule: any) {
  // Get the target producer from the active producers
  const producer = _.find(producers, { owner: producerTracking.producer_account })
  if (!producer) {
    logger.debug({ producer_account: producerTracking.producer_account }, `producer not an active producer`)
    return
  }

  // Get the target producer within the schedule
  const current_schedule = _.find(schedule.active.producers, { producer_name: producerTracking.producer_account })
  if (!current_schedule) {
    logger.debug({ producer_account: producerTracking.producer_account }, `producer not in schedule`)
    return
  }

  // Get the current signing key from the active schedule
  const current_signing_key = current_schedule.block_signing_key

  // Ensure the current key in use is not a potential key to failover to
  if (_.find(producer_signing_pubkeys_nodes, (producer_signing_pubkeys) => producer_signing_pubkeys.includes(current_signing_key))) {
    logger.debug({ producer_signing_pubkeys_nodes, current_signing_key }, 'removing current signing key set from potential failover keys')
    producer_signing_pubkeys_nodes = _.filter(producer_signing_pubkeys_nodes, (producer_signing_pubkeys) => !producer_signing_pubkeys.includes(current_signing_key))
  }

  // If a key change is in progress, do not proceed
  if (
    incomingSigningKeyChange(producerTracking, current_signing_key, schedule, 'proposed')
    || incomingSigningKeyChange(producerTracking, current_signing_key, schedule, 'pending')
  ) {
    // reset the last paid value to reinitialize and prevent secondary trigger under certain circumstances
    producerTracking.last_unpaid = -1
    slack.send(`🕒 signing key changes pending in schedule`)
    return
  }

  const { unpaid_blocks } = producer
  logger.debug({ unpaid_blocks, last_unpaid: producerTracking.last_unpaid }, 'unpaid block states')

  if (producerTracking.last_unpaid === -1) {
    // If this is the first run (-1), just initialize and don't proceed
    logger.info({ unpaid_blocks }, 'initializing unpaid block count on first call')
    producerTracking.last_unpaid = unpaid_blocks
    return
  } else if (unpaid_blocks < producerTracking.last_unpaid) {
    // If the new unpaid is less than the old, the BP has claimed and this value needs to be reset
    logger.debug({ last_unpaid: producerTracking.last_unpaid, unpaid_blocks }, 'resetting unpaid blocks, encountered reward claim')
    producerTracking.last_unpaid = unpaid_blocks
    return
  } else if (unpaid_blocks > producerTracking.last_unpaid) {
    // If the unpaid count is higher than the old count, new blocks were produced
    const newBlocks = unpaid_blocks - producerTracking.last_unpaid
    logger.info({ last_unpaid: producerTracking.last_unpaid, unpaid_blocks }, `round success, witnessed ${newBlocks} new unpaid blocks`)
    // Update the last unpaid value
    producerTracking.last_unpaid = unpaid_blocks
    // If any previously recorded rounds were recorded, reset them
    if (producerTracking.rounds_missed > 0) {
      const msg = `producer recovered after ${producerTracking.rounds_missed} rounds, witnessed ${newBlocks} new unpaid blocks`
      logger.info({ rounds_missed: producerTracking.rounds_missed }, msg)
      slack.send(msg)
      producerTracking.rounds_missed = 0
    }
  } else if (unpaid_blocks === producerTracking.last_unpaid) {
    // If the unpaid blocks is the same as the last time - no new blocks have been produced
    producerTracking.rounds_missed += 1
    logger.info({ last_unpaid: producerTracking.last_unpaid, unpaid_blocks, rounds_missed: producerTracking.rounds_missed }, `producer missed a round!`)
    slack.send(`⚠️ producer missed a round ${producerTracking.rounds_missed}/${rounds_missed_threshold}`)
  }
}

export async function check() {
  // Retrieve the current state of the blockchain
  const state = await getChainState()
  if (!state) { return }

  // Get the active block producers
  const producers = await getActiveProducers()
  if (!producers) { return }

  // Get the current producer schedule
  const schedule = await getProducerSchedule()
  if (!schedule) { return }

  _.each(producersTracking, async (producerTracking) => {
    await checkProducer(producerTracking, state, producers, schedule)
  })

  const rounds_missed = _.reduce(producersTracking, (sum, {rounds_missed}) => sum + rounds_missed, 0)
  // If the new missed rounds exceeds the threshold, begin taking action
  if (rounds_missed >= rounds_missed_threshold) {
    logger.debug({ rounds_missed, rounds_missed_threshold }, 'producers have exceeded missed round threshold, executing failover')
    slack.send(`⚠️ producers exceeded missed round threshold ${rounds_missed}/${rounds_missed_threshold}`)
    // If keys exist, failover to one of them
    if (producer_signing_pubkeys_nodes.length) {
      const producer_signing_pubkeys = producer_signing_pubkeys_nodes.shift()
      _.each(producer_signing_pubkeys, async (next_signing_key, i) => {
        const producerTracking = producersTracking[i]
        const txid = await failover(producerTracking.producer_account, next_signing_key)
        logger.info({ txid, producer_account: producerTracking.producer_account, next_signing_key }, 'regproducer submitted to failover to next available node')
        slack.send(`⚠️ regproducer submitted with new signing key for ${producerTracking.producer_account} with ${next_signing_key}, ${producer_signing_pubkeys_nodes} keys remaining in rotation (${txid})`)
      })
    } else {
      // If no public keys exist, attempt a reload of public keys in order to start over.
      logger.info('no more keys, restarting with original key rotation config')
      producer_signing_pubkeys_nodes = (config.get('producer_signing_pubkeys_nodes') as string[][]).slice()
      slack.send(`⚠️ producers have no backup keys available, restarting with original key rotation config`)
    }
  }
}

export async function main() {
  // Initialize with a first check
  check()
  // Run the check on a set interval based on the length of a round
  setInterval(check, round_timer)
}

function ensureExit(code: number, timeout = 3000) {
  process.exitCode = code
  setTimeout(() => { process.exit(code) }, timeout)
}

if (module === require.main) {
  process.once('uncaughtException', (error) => {
    logger.error(error, 'Uncaught exception')
    ensureExit(1)
  })
  main().catch((error) => {
    logger.fatal(error, 'Unable to start application')
    ensureExit(1)
  })
}
