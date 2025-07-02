// tickets.js
const { PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');

module.exports = async function handleTickets(message, args, sendEmbed, blueColor) {
    const command = args.shift()?.toLowerCase();
    const guild = message.guild;
    const member = message.member;

    if (command !== 'ticket') return false;

    const existing = guild.channels.cache.find(
        (c) => c.name === `ticket-${member.user.username.toLowerCase()}` && c.type === ChannelType.GuildText
    );

    if (existing) {
        await sendEmbed(message.channel, 'Ticket', '🎫 You already have an open ticket.');
        return true;
    }

    const channel = await guild.channels.create({
        name: `ticket-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
            {
                id: guild.roles.everyone,
                deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
                id: member.id,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
            },
            {
                id: message.client.user.id,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
            },
            // Optional: Add staff role permissions
        ],
    });

    await sendEmbed(
        channel,
        'New Ticket',
        `👋 Hello ${member}, staff will be with you shortly. Use \`close\` to close the ticket.`,
        blueColor
    );

    const filter = (m) => m.content.toLowerCase() === 'close' && m.member === member;
    const collector = channel.createMessageCollector({ filter, time: 10 * 60 * 1000 }); // 10 min

    collector.on('collect', async () => {
        await sendEmbed(channel, 'Closing Ticket', '🚪 This ticket will close in 5 seconds...');
        setTimeout(() => channel.delete().catch(() => {}), 5000);
    });

    return true;
};
