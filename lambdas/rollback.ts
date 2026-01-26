// This is meant to handle the 20 block and 2160 block double checks for rolled back data

// Pause the scanner (cron lock in redis)

// 20 confirmation range once a minute

    // Get "20 ago block" (Blockfrost supports get by height/number)
    // Get all blocks/txs/UTxOs from Bf/Ko
    // Get all of the UTxOs from db after that slot 
    // Check for  API <--  missing UTxOs --> Bf/Ko
        // If there are any missing delete/replay 
        // Request all Handles in slot range and hard-set their data from Bf/Ko

// 2160 confirmation range once an hour

    // Get "2160 ago block" (Blockfrost supports get by height/number)
    // Get all blocks/txs/UTxOs from Bf/Ko
    // Get all of the UTxOs from db after that slot 
    // Check for  API <--  missing UTxOs --> Bf/Ko
        // This should be a notify since we are very rarely expecting in this range 
            // and may need to adjust the number 20 above accordingly
        // If there are any missing delete/replay 
        // Request all Handles in slot range and hard-set their data from Bf/Ko

// un-pause the scanner