// Pause the scanner (cron lock in redis)

// Zhu-Li, Do the thing!

if (this.getIndexSchemaVersion() > (indexSchemaVersion ?? 0)) {
    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${this.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    this.repopulateIndexesFromUTxOs(utxoFunctions);
    this.setMetrics({ indexSchemaVersion: this.getIndexSchemaVersion() });
}

// un-pause the scanner