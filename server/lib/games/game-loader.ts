// When loading a game we know:
// - The players involved
// - The config (map, type, etc.)
// We can generate a new game row + use that ID to communicate with players, then:
// - Set up network connections + tell players about them
// - Wait for players games to init + connect (and tell them of progress?)
// - Start a countdown
// - Start the game
