function getRequiredXP(level) {
    return 5 * Math.pow(level, 2) + 50 * level + 100; // Tunable curve
}

/**
 * Parses duration strings like '10s', '5m', '2h', '1d' to milliseconds.
 * @param {string} input
 * @returns {number|null} Duration in milliseconds or null if invalid.
 */
function parseDuration(input) {
    const regex = /^(\d+)(s|m|h|d)$/i;
    const match = input.match(regex);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case 's': return amount * 1000;
        case 'm': return amount * 60 * 1000;
        case 'h': return amount * 60 * 60 * 1000;
        case 'd': return amount * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

module.exports = { parseDuration };

