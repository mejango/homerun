/** Fill canonical placement once; subsequent test mutations remain visible to the proof. */
export function placeReceipt(transaction: { hash: string; from: string; to: string; blockNumber: bigint | null; blockHash: string; transactionIndex?: number }, receipt: { transactionHash: string; blockNumber: bigint; blockHash: string; logs: object[] }) {
  transaction.transactionIndex = 0
  Object.assign(receipt, { from: transaction.from, to: transaction.to, transactionIndex: 0 })
  receipt.logs = receipt.logs.map(log => ({ ...log, transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionIndex: 0, removed: false }))
}
