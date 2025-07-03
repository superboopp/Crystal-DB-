require('dotenv').config();
const moment = require('moment');
const os = require('os');
const fetch = require('node-fetch');
const https = require('https');
const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ChannelType,
} = require('discord.js');
const handleTickets = require('./tickets');
const db = require('./database');
const xpDB = require('./levelingDB');

const PREFIXES = [';', 'c.'];
const blueColor = 0x3498db;
const devs = ['772595594765008917'];
const muteTimers = new Map();
const activeGames = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildBans,
    ],
});

function checkWinner(board) {
    const winPatterns = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
        [0, 4, 8], [2, 4, 6]             // Diagonals
    ];

    for (const pattern of winPatterns) {
        const [a, b, c] = pattern;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    return board.includes(null) ? null : 'Tie';
}

// Helper Functions
const getRequiredXP = (lvl) => 5 * Math.pow(lvl, 2) + 50 * lvl + 100;

const sendEmbed = async (channel, title, description, color = blueColor, fields = []) => {
    const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
    if (fields.length) embed.addFields(fields);
    return channel.send({ embeds: [embed] });
};

const errorEmbed = (channel, desc) => sendEmbed(channel, 'Error', `❌ ${desc}`, 0xe74c3c);
const successEmbed = (channel, desc) => sendEmbed(channel, 'Success', `✅ ${desc}`, 0x2ecc71);

async function getMutedRole(guild) {
    let mutedRole = guild.roles.cache.find(r => r.name === 'Muted');
    if (mutedRole) return mutedRole;

    try {
        mutedRole = await guild.roles.create({
            name: 'Muted',
            color: 'GREY',
            reason: 'Muted role for moderation',
            permissions: [],
        });

        const overwrites = [
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.AddReactions,
            PermissionsBitField.Flags.Speak
        ];

        for (const channel of guild.channels.cache.values()) {
            if (channel.isTextBased()) {
                await channel.permissionOverwrites.create(mutedRole, {
                    SendMessages: false,
                    AddReactions: false,
                    Speak: false,
                }).catch(console.error);
            }
        }
        return mutedRole;
    } catch (e) {
        console.error('Failed to create Muted role:', e);
        return null;
    }
}

async function unmuteUser(guild, userId) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member) return;

        const mutedRole = guild.roles.cache.find(r => r.name === 'Muted');
        if (!mutedRole) return;

        if (member.roles.cache.has(mutedRole.id)) {
            await member.roles.remove(mutedRole, 'Timed mute expired');
            const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
            if (channel) sendEmbed(channel, 'User Unmuted', `Unmuted **${member.user.tag}** (mute time expired).`);
        }
    } catch (e) {
        console.error(`Error unmuting user ${userId}:`, e);
    } finally {
        muteTimers.delete(userId);
    }
}

function sendModLog(guild, embed) {
    const logChannel = guild.channels.cache.find(ch => ch.name === 'admins-log' && ch.isTextBased());
    if (!logChannel) return;
    logChannel.send({ embeds: [embed] }).catch(console.error);
}

// XP System Handler
async function handleXP(message) {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const guildId = message.guild.id;

    const selectStmt = xpDB.prepare('SELECT * FROM xp WHERE user_id = ? AND guild_id = ?');
    const insertStmt = xpDB.prepare('INSERT OR IGNORE INTO xp (user_id, guild_id, xp, level) VALUES (?, ?, ?, ?)');
    const updateStmt = xpDB.prepare('UPDATE xp SET xp = ?, level = ? WHERE user_id = ? AND guild_id = ?');

    let row = selectStmt.get(userId, guildId);

    if (!row) {
        insertStmt.run(userId, guildId, 5, 1);
    } else {
        let newXP = row.xp + 5;
        let newLevel = row.level;
        const requiredXP = getRequiredXP(newLevel);

        if (newXP >= requiredXP) {
            newXP -= requiredXP;
            newLevel++;
            await sendEmbed(message.channel, 'Level Up!', `${message.author} reached level ${newLevel}!`)
            .catch(console.error);
        }

        updateStmt.run(newXP, newLevel, userId, guildId);
    }
}

// Event Handlers
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity(';help', { type: 'LISTENING' });
});

client.on('guildMemberAdd', async member => {
    const guild = member.guild;
    const welcomeChannels = [
        'welcome', 'introductions', 'join-log',
        'arrivals-and-departures', 'newcomers', 'joins', 'general'
    ];

    const welcomeChannel = guild.channels.cache.find(ch =>
    welcomeChannels.includes(ch.name.toLowerCase()) && ch.isTextBased()
    ) || guild.systemChannel;

    if (!welcomeChannel) return;

    const embed = new EmbedBuilder()
    .setColor(blueColor)
    .setTitle('Welcome to the Server!')
    .setThumbnail(member.user.displayAvatarURL({ size: 1024 }))
    .setDescription(`Hey **${member.user.tag}**, welcome to **${guild.name}**!`)
    .addFields(
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
               { name: 'Member Count', value: `${guild.memberCount}`, inline: true }
    )
    .setFooter({ text: 'Enjoy your stay!' })
    .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
        .setLabel('Visit Website')
        .setStyle(ButtonStyle.Link)
        .setURL('https://crystal-mc.xyz')
    );

    welcomeChannel.send({ embeds: [embed], components: [row] }).catch(console.error);
});

// Combined interaction handler for all button interactions
client.on('interactionCreate', async interaction => {
    // Handle unban button
    if (interaction.isButton() && interaction.customId.startsWith('unban_')) {
        const [action, userId] = interaction.customId.split('_');
        if (action !== 'unban') return;

        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.BanMembers)) {
            return interaction.reply({ content: "Missing permissions", ephemeral: true });
        }

        try {
            await interaction.guild.bans.remove(userId, `Unbanned by ${interaction.user.tag}`);
            await interaction.reply({ content: `Unbanned <@${userId}>`, ephemeral: false });

            const embed = new EmbedBuilder()
            .setTitle('User Unbanned')
            .setColor(0x2ecc71)
            .setDescription(`User <@${userId}> was unbanned by ${interaction.user.tag}`)
            .setTimestamp();

            sendModLog(interaction.guild, embed);
        } catch (error) {
            console.error('Unban error:', error);
            interaction.reply({ content: 'Failed to unban user', ephemeral: true });
        }
    }
    // Handle Tic Tac Toe button
    else if (interaction.isButton() && interaction.customId.startsWith('ttt_')) {
        const [prefix, gameId, index] = interaction.customId.split('_');
        const gameState = activeGames.get(gameId);
        if (!gameState) return;

        const playerIndex = gameState.players.indexOf(interaction.user.id);
        if (playerIndex === -1 || playerIndex !== gameState.currentPlayer) {
            return interaction.reply({
                content: '❌ It\'s not your turn!',
                ephemeral: true
            });
        }

        if (gameState.board[index]) {
            return interaction.reply({
                content: '❌ This cell is already taken!',
                ephemeral: true
            });
        }

        // Update game state
        gameState.board[index] = playerIndex === 0 ? 'X' : 'O';
        const winner = checkWinner(gameState.board);

        // Update components
        const updatedRows = [];
        for (let i = 0; i < 3; i++) {
            const row = new ActionRowBuilder();
            for (let j = 0; j < 3; j++) {
                const cellIndex = i * 3 + j;
                const cellValue = gameState.board[cellIndex];

                const button = new ButtonBuilder()
                .setCustomId(`ttt_${gameId}_${cellIndex}`)
                .setDisabled(!!winner || !!cellValue);

                if (cellValue === 'X') {
                    button.setLabel('X').setStyle(ButtonStyle.Primary);
                } else if (cellValue === 'O') {
                    button.setLabel('O').setStyle(ButtonStyle.Danger);
                } else {
                    button.setLabel(' ').setStyle(ButtonStyle.Secondary);
                }

                row.addComponents(button);
            }
            updatedRows.push(row);
        }

        // Update embed
        const embed = new EmbedBuilder()
        .setTitle('Tic Tac Toe')
        .setDescription(`**${interaction.client.users.cache.get(gameState.players[0]).username} (X)** vs **${interaction.client.users.cache.get(gameState.players[1]).username} (O)**`);

        if (winner) {
            if (winner === 'Tie') {
                embed.addFields({ name: 'Result', value: '🏳️ It\'s a tie!' });
            } else {
                const winnerIndex = winner === 'X' ? 0 : 1;
                embed.addFields({
                    name: 'Result',
                    value: `🎉 ${interaction.client.users.cache.get(gameState.players[winnerIndex])} wins!`
                });
            }
            activeGames.delete(gameId);
        } else {
            gameState.currentPlayer = gameState.currentPlayer === 0 ? 1 : 0;
            embed.addFields({
                name: 'Current Turn',
                value: `<@${gameState.players[gameState.currentPlayer]}>`
            });
        }

        await interaction.update({
            embeds: [embed],
            components: updatedRows
        });
    }
});

client.on('messageCreate', async message => {
    // Process XP
    await handleXP(message);

    // Command Handling
    if (message.author.bot || !message.guild) return;

    const prefixUsed = PREFIXES.find(prefix => message.content.startsWith(prefix));
    if (!prefixUsed) return;

    const args = message.content.slice(prefixUsed.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Helper function to get full argument string
    const getFullArgString = () => {
        return message.content.slice(prefixUsed.length + command.length).trim();
    };

    // Handle ticket commands
    const ticketHandled = await handleTickets(message, args, sendEmbed, blueColor);
    if (ticketHandled) return;

    try {
        switch (command) {
            // Developer Commands
            case 'devcommands':
                if (!devs.includes(message.author.id)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const commands = [
                    'devcommands - List developer commands',
                    'devinfo - Bot information',
                    'botinfo - Detailed bot information',
                    'dm <id> <msg> - DM a user',
                    'servers - List servers',
                    'shutdown - Stop bot',
                    'restart - Restart bot',
                    'setactivity <text> - Change status',
                    'stats - System stats',
                    'eval <code> - Execute code',
                    'reload <module> - Reload module'
                ];

                return sendEmbed(message.channel, 'Developer Commands', commands.join('\n'));

            case 'stats':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");

                const memUsage = process.memoryUsage();
            const statsEmbed = new EmbedBuilder()
            .setColor(blueColor)
            .setTitle('System Stats')
            .addFields(
                { name: 'RAM Usage', value: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`, inline: true },
                       { name: 'Heap', value: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`, inline: true },
                       { name: 'Uptime', value: moment.duration(process.uptime(), 'seconds').humanize(), inline: true }
            );

            return message.channel.send({ embeds: [statsEmbed] });

            case 'devinfo':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");

                const totalGuilds = client.guilds.cache.size;
            const totalUsers = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);
            const uptime = moment.duration(client.uptime).humanize();

            const infoEmbed = new EmbedBuilder()
            .setColor(blueColor)
            .setTitle('Bot Information')
            .addFields(
                { name: 'Bot Tag', value: client.user.tag, inline: true },
                { name: 'Bot ID', value: client.user.id, inline: true },
                { name: 'Ping', value: `${client.ws.ping}ms`, inline: true },
                { name: 'Uptime', value: uptime, inline: true },
                { name: 'Servers', value: `${totalGuilds}`, inline: true },
                { name: 'Users', value: `${totalUsers}`, inline: true },
                { name: 'Platform', value: `${os.platform()} (${os.arch()})`, inline: true },
                       { name: 'Node.js', value: process.version, inline: true }
            );

            return message.channel.send({ embeds: [infoEmbed] });

            // Bot Info Command - More detailed version
            case 'botinfo':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");

                const botTotalGuilds = client.guilds.cache.size;
            const botTotalUsers = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);
            const botUptime = moment.duration(client.uptime).humanize();

            const botInfoEmbed = new EmbedBuilder()
            .setColor(blueColor)
            .setTitle('🤖 Crystal Bot Info')
            .setThumbnail(client.user.displayAvatarURL())
            .addFields(
                { name: 'Bot Tag', value: client.user.tag, inline: true },
                { name: 'Bot ID', value: client.user.id, inline: true },
                { name: 'Ping', value: `${client.ws.ping}ms`, inline: true },
                { name: 'Uptime', value: botUptime, inline: true },
                { name: 'Servers', value: `${botTotalGuilds}`, inline: true },
                { name: 'Total Users', value: `${botTotalUsers}`, inline: true },
                { name: 'Platform', value: `${os.platform()} (${os.arch()})`, inline: true },
                       { name: 'Node.js', value: process.version, inline: true },
                       { name: 'Commands', value: '100+', inline: true },
                       { name: 'Developer', value: '<@772595594765008917>', inline: true }
            )
            .setFooter({ text: 'Crystal Bot • v2.0' })
            .setTimestamp();

            return message.channel.send({ embeds: [botInfoEmbed] });

            case 'dm':
                // Permission check
                if (!devs.includes(message.author.id)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                // Get entire argument string
                const dmContent = getFullArgString();
                if (!dmContent) return errorEmbed(message.channel, 'Usage: ;dm <userID> <message>');

                // Split into user ID and message
                const spaceIndex = dmContent.indexOf(' ');
            if (spaceIndex === -1) return errorEmbed(message.channel, 'Usage: ;dm <userID> <message>');

            const targetId = dmContent.substring(0, spaceIndex);
            const dmMessage = dmContent.substring(spaceIndex + 1).trim();

            if (!targetId || !dmMessage) {
                return errorEmbed(message.channel, 'Usage: ;dm <userID> <message>');
            }

            try {
                // Fetch user and validate
                const user = await client.users.fetch(targetId);
                if (user.bot) {
                    return errorEmbed(message.channel, "Cannot DM bots");
                }

                // Create rich embed
                const dmEmbed = new EmbedBuilder()
                .setDescription(dmMessage)
                .setColor('#5865F2') // Discord blurple
                .setFooter({
                    text: message.guild
                    ? `Sent by ${message.author.tag} from ${message.guild.name}`
                    : `Sent by ${message.author.tag}`
                })
                .setTimestamp();

                // Attempt to send
                await user.send({ embeds: [dmEmbed] });

                // Success confirmation
                successEmbed(message.channel, `Message sent to ${user.tag}`);
            } catch (error) {
                console.error('DM Command Error:', error);

                // Handle specific API errors
                const errorMessage = error.code === 50007
                ? "User has DMs disabled"
                : "Failed to send DM";

                errorEmbed(message.channel, `${errorMessage}`);
            }
            break;

            case 'servers':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");

                const serverList = client.guilds.cache.map(g => `${g.name} (${g.id})`).join('\n');
            sendEmbed(message.channel, 'Server List', serverList.substring(0, 2000));
            break;

            case 'shutdown':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");
                await sendEmbed(message.channel, 'Shutting Down', 'Bot is shutting down...');
            process.exit(0);

            case 'restart':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");
                await sendEmbed(message.channel, 'Restarting', 'Bot is restarting...');
            process.exit(1);
            break;

            case 'setactivity':
                if (!devs.includes(message.author.id)) return errorEmbed(message.channel, "Missing permissions");

                // Get entire input after command
                const activityInput = getFullArgString();
            if (!activityInput) return errorEmbed(message.channel, 'Usage: ;setactivity [type] <text>');

            // Split into type and text
            const parts = activityInput.split(' ');
            let activityType = 'PLAYING'; // default
            let activityText = activityInput;

            // Check if first word is a valid activity type
            const validTypes = ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING'];
            if (validTypes.includes(parts[0].toUpperCase())) {
                activityType = parts[0].toUpperCase();
                activityText = parts.slice(1).join(' ');
            }

            if (!activityText) return errorEmbed(message.channel, 'Please provide activity text');

            try {
                const options = { type: activityType };
                if (activityType === 'STREAMING') {
                    options.url = 'https://twitch.tv/your_channel'; // Set your Twitch URL here
                }

                client.user.setActivity(activityText, options);
                successEmbed(message.channel, `Activity set to: ${activityType} ${activityText}`);
            } catch (error) {
                console.error('Error setting activity:', error);
                errorEmbed(message.channel, 'Failed to set activity. Check the console for details.');
            }
            break;

            // Moderation Commands
            case 'kick':
                if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const kickTarget = message.mentions.members.first();
                if (!kickTarget) return errorEmbed(message.channel, "Mention a user");
                if (!kickTarget.kickable) return errorEmbed(message.channel, "Cannot kick this user");

                // Get full reason string
                const kickReason = getFullArgString().replace(kickTarget.toString(), '').trim() || 'No reason provided';
            await kickTarget.kick(kickReason);

            const kickEmbed = new EmbedBuilder()
            .setTitle('User Kicked')
            .setColor(0xe67e22)
            .addFields(
                { name: 'User', value: kickTarget.user.tag, inline: true },
                { name: 'Moderator', value: message.author.tag, inline: true },
                { name: 'Reason', value: kickReason }
            )
            .setTimestamp();

            message.channel.send({ embeds: [kickEmbed] });
            break;

            case 'ban':
                if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const banTarget = message.mentions.members.first();
                if (!banTarget) return errorEmbed(message.channel, "Mention a user");
                if (!banTarget.bannable) return errorEmbed(message.channel, "Cannot ban this user");

                // Prevent self-banning
                if (banTarget.id === message.author.id) {
                    return errorEmbed(message.channel, "You cannot ban yourself");
                }

                // Get full reason string
                const banReason = getFullArgString().replace(banTarget.toString(), '').trim() || 'No reason provided';
                await banTarget.ban({ reason: banReason });

                const unbanButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                    .setCustomId(`unban_${banTarget.id}`)
                    .setLabel('Unban')
                    .setStyle(ButtonStyle.Danger)
                );

                const banEmbed = new EmbedBuilder()
                .setTitle('User Banned')
                .setColor(0xe74c3c)
                .addFields(
                    { name: 'User', value: banTarget.user.tag, inline: true },
                    { name: 'Moderator', value: message.author.tag, inline: true },
                    { name: 'Reason', value: banReason }
                )
                .setTimestamp();

                message.channel.send({
                    embeds: [banEmbed],
                    components: [unbanButton]
                });
                break;

            case 'unban':
                if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const userId = args[0]?.replace(/[<@!>]/g, '');
                if (!userId) return errorEmbed(message.channel, "Provide user ID");

                try {
                    await message.guild.bans.remove(userId, `Unbanned by ${message.author.tag}`);
                    successEmbed(message.channel, `Unbanned user <@${userId}>`);
                } catch (e) {
                    errorEmbed(message.channel, "Failed to unban user");
                }
                break;

            case 'mute':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const muteTarget = message.mentions.members.first();
                if (!muteTarget) return errorEmbed(message.channel, "Mention a user");

                const mutedRole = await getMutedRole(message.guild);
            if (!mutedRole) return errorEmbed(message.channel, "Muted role missing");
            if (muteTarget.roles.cache.has(mutedRole.id)) return errorEmbed(message.channel, "User already muted");

            // Get full argument string without mention
            const muteArgs = getFullArgString().replace(muteTarget.toString(), '').trim().split(/ +/);
            let duration = null;
            let durationText = 'indefinitely';
            let unmuteTime = null;
            let reason = 'No reason provided';

            // Check if next token is a duration string
            if (muteArgs[0] && /^\d+[smhd]$/i.test(muteArgs[0])) {
                const timeArg = muteArgs[0];
                const match = timeArg.match(/^(\d+)([smhd])$/i);
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                const unitMap = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };

                if (amount > 0) {
                    duration = moment.duration(amount, unitMap[unit]);
                    durationText = `for ${amount}${unit}`;
                    unmuteTime = Date.now() + duration.asMilliseconds();
                    reason = muteArgs.slice(1).join(' ') || 'No reason provided';
                } else {
                    reason = muteArgs.join(' ');
                }
            } else {
                reason = muteArgs.join(' ');
            }

            try {
                await muteTarget.roles.add(mutedRole, reason);

                const muteEmbed = new EmbedBuilder()
                .setTitle('User Muted')
                .setColor(0xe67e22)
                .addFields(
                    { name: 'User', value: muteTarget.user.tag, inline: true },
                    { name: 'Duration', value: durationText, inline: true },
                    { name: 'Reason', value: reason, inline: true }
                )
                .setTimestamp();

                if (duration) {
                    muteEmbed.addFields(
                        { name: 'Will be unmuted', value: `<t:${Math.floor(unmuteTime / 1000)}:R>` }
                    );
                    muteTimers.set(muteTarget.id, setTimeout(
                        () => unmuteUser(message.guild, muteTarget.id),
                                                             duration.asMilliseconds()
                    ));
                }

                message.channel.send({ embeds: [muteEmbed] });

                // Send DM notification
                try {
                    const dmEmbed = new EmbedBuilder()
                    .setTitle(`You were muted in ${message.guild.name}`)
                    .setColor(0xe67e22)
                    .addFields(
                        { name: 'Duration', value: durationText, inline: true },
                        { name: 'Reason', value: reason, inline: true }
                    );

                    if (duration) {
                        dmEmbed.addFields(
                            { name: 'Will be unmuted', value: `<t:${Math.floor(unmuteTime / 1000)}:R>` }
                        );
                    }

                    await muteTarget.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log('Failed to send mute DM');
                }
            } catch (e) {
                errorEmbed(message.channel, "Failed to mute user");
            }
            break;

            case 'unmute':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const unmuteTarget = message.mentions.members.first();
                if (!unmuteTarget) return errorEmbed(message.channel, "Mention a user");

                const unmuteRole = await getMutedRole(message.guild);
            if (!unmuteRole) return errorEmbed(message.channel, "Muted role missing");
            if (!unmuteTarget.roles.cache.has(unmuteRole.id)) return errorEmbed(message.channel, "User not muted");

            // Get full reason string
            const unmuteReason = getFullArgString().replace(unmuteTarget.toString(), '').trim() || 'No reason provided';

            try {
                await unmuteTarget.roles.remove(unmuteRole, unmuteReason);

                // Clear timer if exists
                if (muteTimers.has(unmuteTarget.id)) {
                    clearTimeout(muteTimers.get(unmuteTarget.id));
                    muteTimers.delete(unmuteTarget.id);
                }

                const unmuteEmbed = new EmbedBuilder()
                .setTitle('User Unmuted')
                .setColor(0x2ecc71)
                .addFields(
                    { name: 'User', value: unmuteTarget.user.tag, inline: true },
                    { name: 'Reason', value: unmuteReason, inline: true }
                )
                .setTimestamp();

                message.channel.send({ embeds: [unmuteEmbed] });

                // Send DM notification
                try {
                    const dmEmbed = new EmbedBuilder()
                    .setTitle(`You were unmuted in ${message.guild.name}`)
                    .setColor(0x2ecc71)
                    .addFields(
                        { name: 'Reason', value: unmuteReason }
                    );

                    await unmuteTarget.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log('Failed to send unmute DM');
                }
            } catch (e) {
                errorEmbed(message.channel, "Failed to unmute user");
            }
            break;

            case 'purge':
            case 'clear':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                // Get the full argument string and parse it as a number
                const amount = parseInt(getFullArgString());

                if (isNaN(amount) || amount < 1 || amount > 100) {
                    return errorEmbed(message.channel, "Please provide a valid number between 1 and 100");
                }

                try {
                    // Fetch messages (including the command message)
                    const messages = await message.channel.messages.fetch({ limit: amount + 1 });

                    // Delete the messages
                    await message.channel.bulkDelete(messages);

                    // Send confirmation
                    const confirm = await successEmbed(message.channel, `Deleted ${amount} messages`);

                    // Delete confirmation after 5 seconds
                    setTimeout(() => confirm.delete().catch(() => { }), 5000);
                } catch (e) {
                    console.error('Purge Error:', e);
                    errorEmbed(message.channel, "Failed to delete messages");
                }
                break;

                // Warning System
            case 'warn':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const warnTarget = message.mentions.members.first();
                if (!warnTarget) return errorEmbed(message.channel, "Mention a user");

                // Extract entire reason after mention
                const warnReason = getFullArgString().replace(warnTarget.toString(), '').trim();
            if (!warnReason) return errorEmbed(message.channel, 'Specify a reason');

            db.prepare(`
            INSERT INTO warnings (user_id, guild_id, reason, date)
            VALUES (?, ?, ?, ?)
            `).run(warnTarget.id, message.guild.id, warnReason, new Date().toISOString());

            successEmbed(message.channel, `Warned ${warnTarget.user.tag}. Reason: ${warnReason}`);
            break;

            case 'warns':
                const warningsTarget = message.mentions.members.first() || message.member;

                const warnings = db.prepare(`
                SELECT reason, date FROM warnings
                WHERE user_id = ? AND guild_id = ?
                ORDER BY date DESC
                LIMIT 10
                `).all(warningsTarget.id, message.guild.id);

                if (warnings.length === 0) {
                    return sendEmbed(message.channel, 'Warnings', `${warningsTarget.user.tag} has no warnings.`, blueColor);
                }

                const warningsList = warnings.map((w, i) =>
                `${i + 1}. ${w.reason} - ${new Date(w.date).toLocaleString()}`
                ).join('\n');

                sendEmbed(message.channel, `Warnings for ${warningsTarget.user.tag}`, warningsList, 0xf1c40f);
                break;

            case 'clearwarns':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                const clearTarget = message.mentions.members.first();
                if (!clearTarget) return errorEmbed(message.channel, "Mention a user");

                const result = db.prepare(`
                DELETE FROM warnings
                WHERE user_id = ? AND guild_id = ?
                `).run(clearTarget.id, message.guild.id);

                if (result.changes === 0) {
                    return errorEmbed(message.channel, "User has no warnings");
                }

                successEmbed(message.channel, `Cleared ${result.changes} warnings for ${clearTarget.user.tag}`);
                break;

            case 'delwarn':
                if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    return errorEmbed(message.channel, "Missing permissions");
                }

                // Extract target user and index
                const dwTarget = message.mentions.members.first();
                const dwContent = message.content.slice(prefixUsed.length + command.length).trim();

                if (!dwTarget) return errorEmbed(message.channel, "Mention a user");

                // Remove the mention from the content to get the index
                const mention = dwTarget.toString();
            const indexPart = dwContent.replace(mention, '').trim();
            if (!indexPart) return errorEmbed(message.channel, "Specify the warning number to remove");

            const warningIndex = parseInt(indexPart);
            if (isNaN(warningIndex)) return errorEmbed(message.channel, "Invalid warning number");

            // Get all warnings (ordered by date DESC)
            const userWarnings = db.prepare(`
            SELECT id, reason, date FROM warnings
            WHERE user_id = ? AND guild_id = ?
            ORDER BY date DESC
            `).all(dwTarget.id, message.guild.id);

            if (userWarnings.length === 0) {
                return errorEmbed(message.channel, "User has no warnings");
            }

            if (warningIndex < 1 || warningIndex > userWarnings.length) {
                return errorEmbed(message.channel, `Invalid warning number (1-${userWarnings.length})`);
            }

            const warningToDelete = userWarnings[warningIndex - 1];

            db.prepare(`DELETE FROM warnings WHERE id = ?`).run(warningToDelete.id);

            successEmbed(
                message.channel,
                `Removed warning #${warningIndex} from ${dwTarget.user.tag}:\n"${warningToDelete.reason}"`
            );
            break;

            // Information Commands
            case 'servericon':
                const icon = message.guild.iconURL({ size: 1024 });
                if (!icon) return errorEmbed(message.channel, "Server has no icon");

                const iconEmbed = new EmbedBuilder()
                .setTitle(`${message.guild.name} Server Icon`)
                .setImage(icon)
                .setColor(blueColor);

                message.channel.send({ embeds: [iconEmbed] });
                break;

            case 'avatar':
                const avatarUser = message.mentions.users.first() || message.author;

                // Try to get the member object in the current server
                const member = message.guild?.members.cache.get(avatarUser.id);

                // Use server-specific avatar if available, otherwise use global avatar
                const avatar = member?.avatarURL({ size: 1024 }) || avatarUser.displayAvatarURL({ size: 1024 });

                const avatarEmbed = new EmbedBuilder()
                .setTitle(`${avatarUser.username}'s Avatar`)
                .setImage(avatar)
                .setColor(blueColor)
                .setDescription(`[Download](${avatar})`);

                message.channel.send({ embeds: [avatarEmbed] });
                break;

            case 'userinfo':
                const userInfoTarget = message.mentions.members.first() || message.member;
                const roles = userInfoTarget.roles.cache
                .filter(r => r.id !== message.guild.id)
                .map(r => r.name)
                .join(', ') || 'None';

                const userInfoEmbed = new EmbedBuilder()
                .setTitle(`${userInfoTarget.user.tag} Info`)
                .setThumbnail(userInfoTarget.user.displayAvatarURL())
                .addFields(
                    { name: 'ID', value: userInfoTarget.id, inline: true },
                    { name: 'Joined', value: `<t:${Math.floor(userInfoTarget.joinedTimestamp / 1000)}:R>`, inline: true },
                           { name: 'Created', value: `<t:${Math.floor(userInfoTarget.user.createdTimestamp / 1000)}:R>`, inline: true },
                           { name: 'Roles', value: roles }
                )
                .setColor(blueColor);

                message.channel.send({ embeds: [userInfoEmbed] });
                break;

            case 'serverinfo':
                const guild = message.guild;
                const owner = await guild.fetchOwner();
                const channels = guild.channels.cache;
                const rolesCount = guild.roles.cache.size - 1; // Exclude @everyone

                const serverInfoEmbed = new EmbedBuilder()
                .setTitle(`${guild.name} Information`)
                .setThumbnail(guild.iconURL())
                .addFields(
                    { name: 'Owner', value: owner.user.tag, inline: true },
                    { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                           { name: 'Members', value: guild.memberCount.toString(), inline: true },
                           { name: 'Roles', value: rolesCount.toString(), inline: true },
                           { name: 'Text Channels', value: channels.filter(c => c.type === ChannelType.GuildText).size.toString(), inline: true },
                           { name: 'Voice Channels', value: channels.filter(c => c.type === ChannelType.GuildVoice).size.toString(), inline: true }
                )
                .setColor(blueColor);

                message.channel.send({ embeds: [serverInfoEmbed] });
                break;

            case 'website':
                sendEmbed(message.channel, 'Website', '[Visit our website](https://crystal-mc.xyz)', blueColor);
                break;

                // Fun Commands
            case 'joke':
                const jokes = [
                    "Why don't scientists trust atoms? Because they make up everything!",
                    "What do you call a fake noodle? An impasta!",
                    "Why did the scarecrow win an award? Because he was outstanding in his field!"
                ];
                const joke = jokes[Math.floor(Math.random() * jokes.length)];
                sendEmbed(message.channel, 'Joke', joke);
                break;

            case '8ball':
                // Get entire input after command
                const question = getFullArgString();
                if (!question) return errorEmbed(message.channel, "Ask a question");

                const responses = [
                    "It is certain.", "Without a doubt.", "You may rely on it.",
                    "Ask again later.", "Don't count on it.", "My reply is no."
                ];
                const response = responses[Math.floor(Math.random() * responses.length)];
                sendEmbed(message.channel, 'Magic 8-Ball', `**Question:** ${question}\n**Answer:** ${response}`);
                break;

            case 'flip':
                const flipResult = Math.random() < 0.5 ? 'Heads' : 'Tails';
                sendEmbed(message.channel, 'Coin Flip', `It's ${flipResult}!`);
                break;

            case 'weight':
                const subject = message.mentions.users.first() || message.author;
                const weight = Math.floor(Math.random() * 600) + 1;

                sendEmbed(
                    message.channel,
                    'Weight Check',
                    `${subject.username} weighs **${weight} lbs**.`
                );
                break;

            case 'height':
                const subject1 = message.mentions.users.first() || message.author;
                const height = Math.floor(Math.random() * 800) + 1;

                sendEmbed(
                    message.channel,
                    'Height Check',
                    `${subject1.username} is **${height} inches**.`
                );
                break;

            case 'bodycount':
                const subject2 = message.mentions.users.first() || message.author;
                const bodycount = Math.floor(Math.random() * 900) + 1;

                sendEmbed(
                    message.channel,
                    'Height Check',
                    `${subject2.username} has **${bodycount} bodys**.`
                );
                break;

            case 'bald':
                const rand = Math.floor(Math.random() * 100) + 1;
                let status;

                if (rand <= 10) {  // 10% chance
                    status = "completely bald 💡";
                } else if (rand <= 30) {  // 20% chance
                    status = "balding like a middle-aged professor 👨‍🦲";
                } else if (rand <= 60) {  // 30% chance
                    status = "thinning suspiciously 🧐";
                } else if (rand <= 85) {  // 25% chance
                    status = "rocking a full head of hair 💇‍♂️";
                } else {  // 15% chance
                    status = "secretly wearing a wig! 🤫";
                }

                sendEmbed(message.channel, 'Baldness Checker',
                          `\n\n**You are ${status}**`);
                break;

            case 'cat':
                try {
                    https.get('https://api.thecatapi.com/v1/images/search?mime_types=jpg,png', (res) => {
                        let data = '';

                        res.on('data', chunk => data += chunk);
                        res.on('end', async () => {
                            try {
                                const parsed = JSON.parse(data);
                                const imageUrl = parsed[0]?.url;

                                if (!imageUrl) {
                                    return await message.channel.send({
                                        embeds: [new EmbedBuilder()
                                        .setColor(0xe74c3c)
                                        .setDescription('❌ Could not get a cat picture right now.')]
                                    });
                                }

                                const catEmbed = new EmbedBuilder()
                                .setTitle("🐱 Here's a random cat picture!")
                                .setColor(0xffaaff)
                                .setImage(imageUrl)
                                .setFooter({ text: 'Powered by The Cat API' });

                                await message.channel.send({ embeds: [catEmbed] });
                            } catch (err) {
                                console.error('JSON parse error:', err);
                                await message.channel.send({
                                    embeds: [new EmbedBuilder()
                                    .setColor(0xe74c3c)
                                    .setDescription('❌ Failed to load cat picture.')]
                                });
                            }
                        });
                    }).on('error', async (err) => {
                        console.error('HTTPS request error:', err);
                        await message.channel.send({
                            embeds: [new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setDescription('❌ Could not connect to The Cat API.')]
                        });
                    });

                } catch (err) {
                    console.error('Outer error:', err);
                    await message.channel.send({
                        embeds: [new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription('❌ Something went wrong.')]
                    });
                }
                break;

                case 'dog':
                    try {
                        https.get('https://api.thedogapi.com/v1/images/search?mime_types=jpg,png', (res) => {
                            let data = '';

                            res.on('data', chunk => data += chunk);
                            res.on('end', async () => {
                                try {
                                    const parsed = JSON.parse(data);
                                    const imageUrl = parsed[0]?.url;

                                    if (!imageUrl) {
                                        return await message.channel.send({
                                            embeds: [new EmbedBuilder()
                                            .setColor(0xe74c3c)
                                            .setDescription('❌ Could not get a dog picture right now.')]
                                        });
                                    }

                                    const dogEmbed = new EmbedBuilder()
                                    .setTitle("🐶 Here's a random dog picture!")
                                    .setColor(0xffaaff)
                                    .setImage(imageUrl)
                                    .setFooter({ text: 'Powered by The Dog API' });

                                    await message.channel.send({ embeds: [dogEmbed] });
                                } catch (err) {
                                    console.error('JSON parse error:', err);
                                    await message.channel.send({
                                        embeds: [new EmbedBuilder()
                                        .setColor(0xe74c3c)
                                        .setDescription('❌ Failed to load dog picture.')]
                                    });
                                }
                            });
                        }).on('error', async (err) => {
                            console.error('HTTPS request error:', err);
                            await message.channel.send({
                                embeds: [new EmbedBuilder()
                                .setColor(0xe74c3c)
                                .setDescription('❌ Could not connect to The Dog API.')]
                            });
                        });

                    } catch (err) {
                        console.error('Outer error:', err);
                        await message.channel.send({
                            embeds: [new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setDescription('❌ Something went wrong.')]
                        });
                    }
                    break;

                    case 'eat':
                        // Get target user (mention or author)
                        const target = message.mentions.users.first() || message.author;

                        const username = target.username;

                        // 5% chance of being too full to eat
                        if (Math.random() < 0.05) {
                            sendEmbed(message.channel, 'Hungry Bot',
                                      `*patpat* I'm too full to eat anyone right now! Maybe try again later? 🥺`);
                            break;
                        }

                        // Body parts and cooking styles
                        const bodyParts = [
                            'left foot', 'right arm', 'nose', 'ears', 'liver', 'thigh',
                            'eyeballs', 'fingers', 'spleen', 'toes', 'kidneys', 'tongue'
                        ];
                        const cookingStyles = [
                            'deep-fried', 'stir-fried', 'raw', 'steamed', 'boiled', 'grilled',
                            'microwaved', 'sous-vide', 'blended', 'fermented', 'freeze-dried'
                        ];
                        const sauces = [
                            'ketchup', 'mayonnaise', 'soy sauce', 'ranch dressing', 'BBQ sauce',
                            'sriracha', 'honey mustard', 'teriyaki glaze', 'buffalo sauce'
                        ];
                        const sides = [
                            'with a side of fries', 'with mashed potatoes', 'on a bed of rice',
                            'with coleslaw', 'in a taco', 'on pizza', 'in a salad', 'as sushi'
                        ];

                        // Random selections
                        const part = bodyParts[Math.floor(Math.random() * bodyParts.length)];
                        const style = cookingStyles[Math.floor(Math.random() * cookingStyles.length)];
                        const sauce = sauces[Math.floor(Math.random() * sauces.length)];
                        const side = sides[Math.floor(Math.random() * sides.length)];

                        sendEmbed(message.channel, 'Nom Nom Nom!',
                                  `**${message.author.username}** just ate **${username}'s ${part}**!\n` +
                                  `*Prepared ${style} ${side}, topped with ${sauce}.* 😋🍽️`);
                        break;

                    case 'tictactoe':
                    case 'ttt':
                        try {
                            const opponent = message.mentions.users.first();
                            if (!opponent || opponent.id === message.author.id) {
                                return message.reply('Please mention a valid opponent to play against!');
                            }
                            if (opponent.bot) {
                                return message.reply('You cannot play against a bot!');
                            }

                            // Generate a unique game ID (using the message id of the command)
                            const gameId = message.id;

                            // Initialize the game state
                            const board = Array(9).fill(null);
                            activeGames.set(gameId, {
                                players: [message.author.id, opponent.id],
                                board: board,
                                currentPlayer: 0 // 0 for first player (X), 1 for second (O)
                            });

                            // Create embed
                            const embed = new EmbedBuilder()
                            .setTitle('Tic Tac Toe')
                            .setDescription(`**${message.author} (X)** vs **${opponent} (O)**\n\nCurrent turn: ${message.author}`)
                            .setColor(0x3498db);

                            // Create buttons
                            const rows = [];
                            for (let i = 0; i < 3; i++) {
                                const row = new ActionRowBuilder();
                                for (let j = 0; j < 3; j++) {
                                    const index = i * 3 + j;
                                    const button = new ButtonBuilder()
                                    .setCustomId(`ttt_${gameId}_${index}`)
                                    .setLabel(' ')
                                    .setStyle(ButtonStyle.Secondary);
                                    row.addComponents(button);
                                }
                                rows.push(row);
                            }

                            await message.channel.send({ embeds: [embed], components: rows });
                        } catch (err) {
                            console.error('Tic-Tac-Toe error:', err);
                            message.reply('An error occurred while setting up the Tic-Tac-Toe game.');
                        }
                        break;

                    case 'kiss':
                        const kissTarget = message.mentions.users.first();
                        if (!kissTarget) {
                            sendEmbed(message.channel, 'Kiss', 'Who are you trying to kiss? Mention someone!');
                            break;
                        }

                        const kisses = [
                            `💋 ${message.author.username} planted a soft kiss on ${kissTarget.username}'s cheek!`,
                            `😘 ${message.author.username} gave ${kissTarget.username} a passionate french kiss!`,
                            `👩‍❤️‍💋‍👨 ${message.author.username} surprised ${kissTarget.username} with a romantic kiss!`,
                            `😚 ${message.author.username} blew a kiss to ${kissTarget.username} from across the room!`,
                            `💏 ${message.author.username} shared a tender kiss with ${kissTarget.username}!`
                        ];

                        const randomKiss = kisses[Math.floor(Math.random() * kisses.length)];
                        sendEmbed(message.channel, 'Kiss!', randomKiss);
                        break;

                    case 'slowmode':
                        // Permission check (Manage Channels)
                        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
                            sendEmbed(message.channel, 'Slowmode Error',
                                      '❌ You need the **Manage Channels** permission to use this command!');
                            break;
                        }

                        const timeInput = args[0]; // Get the time argument

                        // Disable slowmode
                        if (!timeInput || timeInput.toLowerCase() === 'off') {
                            message.channel.setRateLimitPerUser(0)
                            .then(() => {
                                sendEmbed(message.channel, 'Slowmode Disabled',
                                          '✅ Slowmode has been turned off in this channel!');
                            })
                            .catch(err => {
                                console.error(err);
                                sendEmbed(message.channel, 'Slowmode Error',
                                          '❌ Failed to disable slowmode! Please try again.');
                            });
                            break;
                        }

                        // Parse time input (supports seconds, minutes, hours)
                        let seconds;
                        if (isNaN(timeInput)) {
                            // Handle time formats like "10s", "5m", "2h"
                            const unit = timeInput.slice(-1).toLowerCase();
                            const value = parseInt(timeInput.slice(0, -1));

                            if (isNaN(value)) {
                                sendEmbed(message.channel, 'Slowmode Error',
                                          '❌ Invalid time format! Use seconds (10), minutes (5m), or hours (2h)');
                                break;
                            }

                            switch (unit) {
                                case 's': seconds = value; break;
                                case 'm': seconds = value * 60; break;
                                case 'h': seconds = value * 3600; break;
                                default:
                                    sendEmbed(message.channel, 'Slowmode Error',
                                              '❌ Invalid time unit! Use `s` (seconds), `m` (minutes), or `h` (hours)');
                                    return;
                            }
                        } else {
                            // Plain number (seconds)
                            seconds = parseInt(timeInput);
                        }

                        // Validate time range (0-21600 seconds = 6 hours)
                        if (seconds < 0 || seconds > 21600) {
                            sendEmbed(message.channel, 'Slowmode Error',
                                      '❌ Slowmode must be between 0 and 6 hours (21600 seconds)!');
                            break;
                        }

                        // Apply slowmode
                        message.channel.setRateLimitPerUser(seconds)
                        .then(() => {
                            // Format time for display
                            let timeDisplay;
                            if (seconds === 0) timeDisplay = 'disabled';
                            else if (seconds < 60) timeDisplay = `${seconds} second${seconds !== 1 ? 's' : ''}`;
                            else if (seconds < 3600) timeDisplay = `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) !== 1 ? 's' : ''}`;
                            else timeDisplay = `${(seconds / 3600).toFixed(1)} hours`;

                            sendEmbed(message.channel, 'Slowmode Set',
                                      `⏱️ Slowmode set to **${timeDisplay}** in ${message.channel}`);
                        })
                        .catch(err => {
                            console.error(err);
                            sendEmbed(message.channel, 'Slowmode Error',
                                      '❌ Failed to set slowmode! Please try again.');
                        });
                        break;
                                case 'ping':
                                    const sent = await message.channel.send({ content: 'Pinging...' });
                                    const timeDiff = sent.createdTimestamp - message.createdTimestamp;
                                    const pingEmbed = new EmbedBuilder()
                                    .setColor(blueColor)
                                    .setTitle('🏓 Pong!')
                                    .addFields(
                                        { name: 'Bot Latency', value: `${timeDiff}ms`, inline: true },
                                        { name: 'API Latency', value: `${client.ws.ping}ms`, inline: true }
                                    );
                                    sent.edit({ content: '', embeds: [pingEmbed] });
                                    break;
                                case 'level':
                                    const user = message.mentions.users.first() || message.author;
                                    const guildId = message.guild.id;
                                    const row = xpDB.prepare('SELECT * FROM xp WHERE user_id = ? AND guild_id = ?').get(user.id, guildId);

                                    if (!row) {
                                        return sendEmbed(message.channel, 'Level', `${user.tag} has no XP yet!`);
                                    }

                                    const requiredXP = getRequiredXP(row.level);
                                    const progress = Math.round((row.xp / requiredXP) * 100);

                                    const levelEmbed = new EmbedBuilder()
                                    .setColor(blueColor)
                                    .setTitle(`${user.username}'s Level`)
                                    .setThumbnail(user.displayAvatarURL())
                                    .addFields(
                                        { name: 'Level', value: `${row.level}`, inline: true },
                                        { name: 'XP', value: `${row.xp}/${requiredXP}`, inline: true },
                                        { name: 'Progress', value: `${progress}%` }
                                    );

                                    message.channel.send({ embeds: [levelEmbed] });
                                    break;
                                case 'addrole':
                                    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                                        return errorEmbed(message.channel, "Missing permissions");
                                    }

                                    const addTarget = message.mentions.members.first();
                                    if (!addTarget) return errorEmbed(message.channel, "Mention a user");

                                    const roleToAdd = message.mentions.roles.first();
            if (!roleToAdd) return errorEmbed(message.channel, "Mention a role");

            try {
                await addTarget.roles.add(roleToAdd);
                successEmbed(message.channel, `Added ${roleToAdd.name} role to ${addTarget.user.tag}`);
            } catch (e) {
                errorEmbed(message.channel, "Failed to add role");
            }
            break;

                                case 'removerole':
                                    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                                        return errorEmbed(message.channel, "Missing permissions");
                                    }

                                    const removeTarget = message.mentions.members.first();
                                    if (!removeTarget) return errorEmbed(message.channel, "Mention a user");

                                    const roleToRemove = message.mentions.roles.first();
            if (!roleToRemove) return errorEmbed(message.channel, "Mention a role");

            try {
                await removeTarget.roles.remove(roleToRemove);
                successEmbed(message.channel, `Removed ${roleToRemove.name} role from ${removeTarget.user.tag}`);
            } catch (e) {
                errorEmbed(message.channel, "Failed to remove role");
            }
            break;
                                case 'invite':
                                    try {
                                        const invite = await message.channel.createInvite({
                                            maxAge: 86400, // 24 hours
                                            maxUses: 10
                                        });

                                        const inviteEmbed = new EmbedBuilder()
                                        .setColor(0x9b59b6)
                                        .setTitle('Server Invite')
                                        .setDescription(`Here's your invite link: ${invite.url}`)
                                        .setFooter({ text: 'Expires in 24 hours or after 10 uses' });

                                        message.author.send({ embeds: [inviteEmbed] })
                                        .then(() => successEmbed(message.channel, 'Invite sent to your DMs!'))
                                        .catch(() => errorEmbed(message.channel, "Couldn't send DM. Check your privacy settings!"));
                                    } catch (e) {
                                        errorEmbed(message.channel, "Failed to create invite");
                                    }
                                    break;

                                case 'hug': {
                                    const user = message.mentions.users.first();
                                    if (!user) return message.channel.send('Mention someone to hug!');
                                    return message.channel.send(`${message.author} gives a warm hug to ${user} 🤗`);
                                }

                                case 'rate': {
                                    const item = getFullArgString();
                                    if (!item || item.trim() === '') return message.channel.send('What should I rate?');
                                    const score = Math.floor(Math.random() * 11);
                                    return message.channel.send(`I'd rate **${item}** a solid **${score}/10**.`);
                                }

                                case 'meme': {
                                    const url = 'https://meme-api.com/gimme';

                                    https.get(url, res => {
                                        let data = '';
                                        res.on('data', chunk => data += chunk);
                                        res.on('end', () => {
                                            const meme = JSON.parse(data);
                                            if (meme && meme.url) {
                                                const embed = {
                                                    title: meme.title,
                                                    image: { url: meme.url },
                                                    footer: { text: `👍 ${meme.ups} | r/${meme.subreddit}` },
                                                    color: 0x00bfff
                                                };
                                                message.channel.send({ embeds: [embed] });
                                            } else {
                                                message.channel.send('No meme found.');
                                            }
                                        });
                                    }).on('error', () => {
                                        message.channel.send('Error fetching meme.');
                                    });
                                    break;
                                }

                                // Help Command
                                case 'help': {
                                    // Define command categories
                                    const helpPages = [
                                        {
                                            title: "Moderation Commands",
          description: "Commands for server moderation",
          commands: [
              "`kick <user> [reason]` - Kick a user",
          "`ban <user> [reason]` - Ban a user",
          "`unban <userID>` - Unban a user",
          "`mute <user> [time] [reason]` - Mute a user",
          "`unmute <user>` - Unmute a user",
          "`purge <amount>` - Delete messages",
          "`warn <user> <reason>` - Warn a user",
          "`warns [user]` - View warnings",
          "`clearwarns <user>` - Clear warnings",
          "`delwarn <user> <num>` - Delete a specific warning",
          "`addrole <user> <role>` - Add role to user",
          "`removerole <user> <role>` - Remove role from user",
          "`slowmode [time]` - Set slowmode"
          ]
                                        },
          {
              title: "Information Commands",
          description: "Commands for server information",
          commands: [
              "`userinfo [user]` - Show user details",
          "`serverinfo` - Show server information",
          "`avatar [user]` - Show user avatar",
          "`servericon` - Show server icon",
          "`level [user]` - Show level/XP",
          "`website` - Show website link",
          "`ping` - Check bot latency",
          "`invite` - Get server invite"
          ]
          },
          {
              title: "Fun Commands",
          description: "Entertainment commands",
          commands: [
              "`joke` - Tell a random joke",
          "`8ball <question>` - Magic 8-ball",
          "`flip` - Flip a coin",
          "`cat` - Show random cat image",
          "`dog` - Show random dog image",
          "`weight` - Generate random weight",
          "`bald` - Baldness checker",
          "`eat [user]` - Eat someone (roleplay)",
          "`kiss [user]` - Kiss someone (roleplay)",
          "`tictactoe @user` - Play Tic Tac Toe",
          "`hug [user]` - Hug someone (roleplay)",
          "`rate <thing>` - Rates anything out of 10",
          "`meme` - Sends a random meme"
          ]
          }
                                    ];

                                    // Add developer page if user is dev
                                    if (devs.includes(message.author.id)) {
                                        helpPages.push({
                                            title: "Developer Commands",
                                            description: "Bot owner only commands",
                                            commands: [
                                                "`devcommands` - List developer commands",
                                                "`devinfo` - Show bot info",
                                                "`botinfo` - Detailed bot information",
                                                "`dm <userID> <message>` - DM a user",
                                                "`servers` - List all servers",
                                                "`shutdown` - Shutdown bot",
                                                "`restart` - Restart bot",
                                                "`setactivity <text>` - Set bot activity",
                                                "`stats` - Show system stats"
                                            ]
                                        });
                                    }

                                    let currentPage = 0;
                                    const totalPages = helpPages.length;

                                    // Function to generate embed for current page
                                    const generateEmbed = () => {
                                        return new EmbedBuilder()
                                        .setTitle(helpPages[currentPage].title)
                                        .setDescription(helpPages[currentPage].description)
                                        .addFields(
                                            { name: "Commands", value: helpPages[currentPage].commands.join('\n') }
                                        )
                                        .setFooter({ text: `Page ${currentPage + 1} of ${totalPages}` })
                                        .setColor(blueColor);
                                    };

                                    // Create action row with buttons
                                    const paginationRow = new ActionRowBuilder().addComponents(
                                        new ButtonBuilder()
                                        .setCustomId('prev')
                                        .setLabel('Previous')
                                        .setStyle(ButtonStyle.Primary)
                                        .setDisabled(currentPage === 0),
                                                                                               new ButtonBuilder()
                                                                                               .setCustomId('next')
                                                                                               .setLabel('Next')
                                                                                               .setStyle(ButtonStyle.Primary)
                                                                                               .setDisabled(currentPage === totalPages - 1)
                                    );

                                    // Send initial message
                                    const helpMessage = await message.channel.send({
                                        embeds: [generateEmbed()],
                                                                                   components: [paginationRow]
                                    });

                                    // Create button collector
                                    const filter = i => i.user.id === message.author.id;
                                    const collector = helpMessage.createMessageComponentCollector({
                                        filter,
                                        time: 60000, // 1 minute timeout
                                        componentType: ComponentType.Button
                                    });

                                    collector.on('collect', async interaction => {
                                        if (interaction.customId === 'prev' && currentPage > 0) {
                                            currentPage--;
                                        } else if (interaction.customId === 'next' && currentPage < totalPages - 1) {
                                            currentPage++;
                                        }

                                        // Update buttons
                                        paginationRow.components[0].setDisabled(currentPage === 0);
                                        paginationRow.components[1].setDisabled(currentPage === totalPages - 1);

                                        // Update message
                                        await interaction.update({
                                            embeds: [generateEmbed()],
                                                                 components: [paginationRow]
                                        });
                                    });

                                    collector.on('end', () => {
                                        // Disable buttons when collector ends
                                        const disabledRow = new ActionRowBuilder().addComponents(
                                            new ButtonBuilder()
                                            .setCustomId('prev')
                                            .setLabel('Previous')
                                            .setStyle(ButtonStyle.Secondary)
                                            .setDisabled(true),
                                                                                                 new ButtonBuilder()
                                                                                                 .setCustomId('next')
                                                                                                 .setLabel('Next')
                                                                                                 .setStyle(ButtonStyle.Secondary)
                                                                                                 .setDisabled(true)
                                        );

                                        helpMessage.edit({ components: [disabledRow] }).catch(console.error);
                                    });
                                    break;
                                }
        }
    } catch (error) {
        console.error('Command Error:', error);
        errorEmbed(message.channel, 'An error occurred while executing that command');
    }
});

client.login(process.env.DISCORD_TOKEN);
