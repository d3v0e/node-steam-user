const BBCode = require('@bbob/parser');
const Crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;
const StdLib = require('@doctormckay/stdlib');
const SteamID = require('steamid');
const Util = require('util');

const EChatEntryType = require('../enums/EChatEntryType.js');
const EResult = require('../enums/EResult.js');

const Helpers = require('./helpers.js');

Util.inherits(SteamChatRoomClient, EventEmitter);

module.exports = SteamChatRoomClient;

function SteamChatRoomClient(user) {
	this.user = user;

	this.user._handlerManager.add('FriendMessagesClient.IncomingMessage#1', function(body) {
		body = preProcessObject(body);
		body.local_echo = body.local_echo || false; // coerce null to false
		body.from_limited_account = body.from_limited_account || false;
		body.low_priority = body.low_priority || false;
		body.ordinal = body.ordinal || 0;
		body.server_timestamp = body.rtime32_server_timestamp;
		body.message_no_bbcode = body.message_no_bbcode || body.message;
		body.message_bbcode_parsed = parseBbCode(body.message);
		delete body.rtime32_server_timestamp;

		let eventName = "";
		switch (body.chat_entry_type) {
			case EChatEntryType.ChatMsg:
				eventName = 'friendMessage';
				break;

			case EChatEntryType.Typing:
				eventName = 'friendTyping';
				break;

			case EChatEntryType.LeftConversation:
				eventName = 'friendLeftConversation';
				break;

			default:
				this.emit('debug', 'Got unknown chat entry type ' + body.chat_entry_type + ' from ' + body.steamid_friend);
		}

		if (body.local_echo) {
			eventName += 'Echo';
		}

		this.chat.emit(eventName, body);

		// backwards compatibility
		this._emitIdEvent(eventName, body.steamid_friend, body.message_no_bbcode);
		if (body.chat_entry_type == EChatEntryType.ChatMsg) {
			this._emitIdEvent('friendOrChatMessage', body.steamid_friend, body.message_no_bbcode, body.steamid_friend);
		}
	});

	this.user._handlerManager.add('ChatRoomClient.NotifyIncomingChatMessage#1', function(body) {
		body = preProcessObject(body);
		body.server_timestamp = body.timestamp;
		delete body.timestamp;
		body.ordinal = body.ordinal || 0;
		body.message_no_bbcode = body.message_no_bbcode || body.message;
		body.message_bbcode_parsed = parseBbCode(body.message);

		if (body.mentions) {
			body.mentions = processChatMentions(body.mentions);
		}

		this.chat.emit('chatMessage', body);
	});

	this.user._handlerManager.add('ChatRoomClient.NotifyChatMessageModified#1', function(body) {
		body = preProcessObject(body);
		body.messages = body.messages.map((msg) => {
			msg.ordinal = msg.ordinal || 0;
			return msg;
		});

		this.chat.emit('chatMessagesModified', body);
	});
}

/**
 * Get a list of the chat room groups you're in.
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.getGroups = function(callback) {
	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		this.user._sendUnified("ChatRoom.GetMyChatRoomGroups#1", {}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.chat_room_groups = body.chat_room_groups.map(v => processChatRoomSummaryPair(v));
			let groups = {};
			body.chat_room_groups.forEach((group) => {
				groups[group.group_summary.chat_group_id] = group;
			});

			body.chat_room_groups = groups;
			accept(body);
		});
	});
};

/**
 * Set which groups are actively being chatted in by this session. It's unclear what effect this has on the chatting
 * experience, other than retrieving chat room group states.
 * @param {int[]|string[]|int|string} groupIDs - Array of group IDs you want data for
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.setSessionActiveGroups = function(groupIDs, callback) {
	if (!Array.isArray(groupIDs)) {
		groupIDs = [groupIDs];
	}

	return StdLib.Promises.callbackPromise(null, callback, (resolve, reject) => {
		this.user._sendUnified("ChatRoom.SetSessionActiveChatRoomGroups#1", {
			"chat_group_ids": groupIDs,
			"chat_groups_data_requested": groupIDs
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			let groups = {};
			body.chat_states.forEach((group) => {
				groups[group.header_state.chat_group_id] = processChatGroupState(group);
			});

			resolve({"chat_room_groups": groups});
		});
	});
};

/**
 * Get details from a chat group invite link.
 * @param {string} linkUrl
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.getInviteLinkInfo = function(linkUrl, callback) {
	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		let match = linkUrl.match(/^https?:\/\/s\.team\/chat\/([^\/]+)$/);
		if (!match) {
			return reject(new Error("Invalid invite link"));
		}

		this.user._sendUnified("ChatRoom.GetInviteLinkInfo#1", {"invite_code": match[1]}, (body, hdr) => {
			if (hdr.proto.eresult == EResult.InvalidParam) {
				let err = new Error('Invalid invite link');
				err.eresult = hdr.proto.eresult;
				return reject(err);
			}

			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body = preProcessObject(body);
			if (Math.floor(body.time_expires / 1000) == Math.pow(2, 31) - 1) {
				body.time_expires = null;
			}

			body.group_summary = processChatGroupSummary(body.group_summary, true);
			body.user_chat_group_state = processUserChatGroupState(body.user_chat_group_state, true);
			body.banned = !!body.banned;
			body.invite_code = match[1];
			accept(body);
		});
	});
};

/**
 * Get the chat room group info for a clan (Steam group). Allows you to join a group chat.
 * @param {SteamID|string} clanSteamID - The group's SteamID or a string that can parse into one
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.getClanChatGroupInfo = function(clanSteamID, callback) {
	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		clanSteamID = Helpers.steamID(clanSteamID);
		if (clanSteamID.type != SteamID.Type.CLAN) {
			return reject(new Error("SteamID is not for a clan"));
		}

		// just set these to what they should be
		clanSteamID.universe = SteamID.Universe.PUBLIC;
		clanSteamID.instance = SteamID.Instance.ALL;

		this.user._sendUnified("ClanChatRooms.GetClanChatRoomInfo#1", {
			"steamid": clanSteamID.toString(),
			"autocreate": true
		}, (body, hdr) => {
			if (hdr.proto.eresult == EResult.Busy) {
				// Why "Busy"? Because Valve.
				let err = new Error("Invalid clan ID");
				err.eresult = hdr.proto.eresult;
				return reject(err);
			}

			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.chat_group_summary = processChatGroupSummary(body.chat_group_summary);
			accept(body);
		});
	});
};

/**
 * Join a chat room group.
 * @param {int|string} groupId - The group's ID
 * @param {string} [inviteCode] - An invite code to join this chat. Not necessary for public Steam groups.
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.joinGroup = function(groupId, inviteCode, callback) {
	if (typeof inviteCode === 'function') {
		callback = inviteCode;
		inviteCode = undefined;
	}

	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		this.user._sendUnified("ChatRoom.JoinChatRoomGroup#1", {
			"chat_group_id": groupId,
			"invite_code": inviteCode
		}, (body, hdr) => {
			if (hdr.proto.eresult == EResult.InvalidParam) {
				let err = new Error("Invalid group ID or invite code");
				err.eresult = hdr.proto.eresult;
				return reject(err);
			}

			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body = preProcessObject(body);
			body.state = processChatGroupState(body.state, true);
			body.user_chat_state = processUserChatGroupState(body.user_chat_state, true);
			accept(body);
		});
	});
};

/**
 * Invite a friend to a chat room group.
 * @param {int} groupId
 * @param {SteamID|string} steamId
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.inviteUserToGroup = function(groupId, steamId, callback) {
	return StdLib.Promises.callbackPromise(null, callback, true, (accept, reject) => {
		this.user._sendUnified("ChatRoom.InviteFriendToChatRoomGroup#1", {
			"chat_group_id": groupId,
			"steamid": Helpers.steamID(steamId).toString()
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			accept();
		});
	});
};

/**
 * Create an invite link for a given chat group.
 * @param {int} groupId
 * @param {{secondsValid?: int, voiceChatId?: int}} [options]
 * @param {function} [callback]
 * @returns {Promise<{invite_code: string, invite_url: string, seconds_valid: int}>}
 */
SteamChatRoomClient.prototype.createInviteLink = function(groupId, options, callback) {
	if (typeof options == 'function') {
		callback = options;
		options = {};
	}

	options = options || {};

	return StdLib.Promises.callbackPromise(null, callback, (resolve, reject) => {
		this.user._sendUnified('ChatRoom.CreateInviteLink#1', {
			"chat_group_id": groupId,
			"seconds_valid": options.secondsValid || 60 * 60,
			"chat_id": options.voiceChatId
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.invite_url = 'https://s.team/chat/' + body.invite_code;
			resolve(body);
		});
	});
};

/**
 * Get all active invite links for a given chat group.
 * @param {int} groupId
 * @param {function} [callback]
 * @returns {Promise<{invite_links: {invite_code: string, invite_url: string, steamid_creator: SteamID, time_expires: Date|null, chat_id: string}[]}>}
 */
SteamChatRoomClient.prototype.getGroupInviteLinks = function(groupId, callback) {
	return StdLib.Promises.callbackPromise(null, callback, (resolve, reject) => {
		this.user._sendUnified('ChatRoom.GetInviteLinksForGroup#1', {
			"chat_group_id": groupId
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.invite_links = body.invite_links.map(v => preProcessObject(v)).map((link) => {
				if (Math.floor(link.time_expires / 1000) == Math.pow(2, 31) - 1) {
					link.time_expires = null;
				}

				if (link.chat_id == 0) {
					link.chat_id = null;
				}

				link.invite_url = 'https://s.team/chat/' + link.invite_code;
				return link;
			});

			resolve(body);
		});
	});
};

/**
 * Revoke and delete an active invite link.
 * @param {string} linkUrl
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.deleteInviteLink = function(linkUrl, callback) {
	return StdLib.Promises.callbackPromise(null, callback, true, async (resolve, reject) => {
		let details = await this.getInviteLinkInfo(linkUrl);

		this.user._sendUnified('ChatRoom.DeleteInviteLink#1', {
			"chat_group_id": details.group_summary.chat_group_id,
			"invite_code": details.invite_code
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			resolve();
		});
	});
};

/**
 * Send a direct chat message to a friend.
 * @param {SteamID|string} steamId
 * @param {string} message
 * @param {{[chatEntryType], [containsBbCode]}} [options]
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.sendFriendMessage = function(steamId, message, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	} else if (!options) {
		options = {};
	}

	if (!options.chatEntryType) {
		options.chatEntryType = EChatEntryType.ChatMsg;
	}

	if (options.chatEntryType && typeof options.containsBbCode === 'undefined') {
		options.containsBbCode = true;
	}

	return StdLib.Promises.callbackPromise(null, callback, true, (accept, reject) => {
		this.user._sendUnified("FriendMessages.SendMessage#1", {
			"steamid": Helpers.steamID(steamId).toString(),
			"chat_entry_type": options.chatEntryType,
			"message": message,
			"contains_bbcode": options.containsBbCode
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body = preProcessObject(body);
			body.ordinal = body.ordinal || 0;
			body.modified_message = body.modified_message || message;
			body.message_bbcode_parsed = parseBbCode(body.modified_message);
			accept(body);
		});
	});
};

/**
 * Inform a friend that you're typing a message to them.
 * @param {SteamID|string} steamId
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.sendFriendTyping = function(steamId, callback) {
	return this.sendFriendMessage(steamId, "", {"chatEntryType": EChatEntryType.Typing}, callback);
};

/**
 * Send a message to a chat room.
 * @param {int|string} groupId
 * @param {int|string} chatId
 * @param {string} message
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.sendChatMessage = function(groupId, chatId, message, callback) {
	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		this.user._sendUnified("ChatRoom.SendChatMessage#1", {
			"chat_group_id": groupId,
			"chat_id": chatId,
			"message": message
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body = preProcessObject(body);
			body.ordinal = body.ordinal || 0;
			body.modified_message = body.modified_message || message;
			body.message_bbcode_parsed = parseBbCode(body.modified_message);
			accept(body);
		});
	});
};

/**
 * Get a list of which friends we have "active" (recent) message sessions with.
 * @param {{conversationsSince?: Date|int}} [options]
 * @param {function} [callback]
 * @returns {Promise<{sessions: {steamid_friend: SteamID, time_last_message: Date, time_last_view: Date, unread_message_count: int}[], timestamp: Date}>}
 */
SteamChatRoomClient.prototype.getActiveFriendMessageSessions = function(options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}

	options = options || {};

	return StdLib.Promises.callbackPromise(null, callback, (resolve, reject) => {
		let lastmessage_since = options.conversationsSince ? convertDateToUnix(options.conversationsSince) : undefined;

		this.user._sendUnified("FriendMessages.GetActiveMessageSessions#1", {
			lastmessage_since
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			let output = {
				"sessions": body.message_sessions || [],
				"timestamp": body.timestamp ? new Date(body.timestamp * 1000) : null
			};

			output.sessions = output.sessions.map((session) => {
				return {
					"steamid_friend": SteamID.fromIndividualAccountID(session.accountid_friend),
					"time_last_message": session.last_message ? new Date(session.last_message * 1000) : null,
					"time_last_view": session.last_view ? new Date(session.last_view * 1000) : null,
					"unread_message_count": session.unread_message_count
				};
			});

			resolve(output);
		});
	});
};

/**
 * Get your chat message history with a Steam friend.
 * @param {SteamID|string} friendSteamId
 * @param {{maxCount?: int, wantBbcode?: boolean, startTime?: Date|int, startOrdinal?: int, lastTime?: Date|int, lastOrdinal?: int}} [options]
 * @param {function} [callback]
 * @returns {Promise<{messages: {sender: SteamID, server_timestamp: Date, ordinal: int, message: string, message_bbcode_parsed: null|Array}[], more_available: boolean}>}
 */
SteamChatRoomClient.prototype.getFriendMessageHistory = function(friendSteamId, options, callback) {
	if (typeof options == 'function') {
		callback = options;
		options = {};
	}

	options = options || {};

	return StdLib.Promises.callbackPromise(null, callback, async (resolve, reject) => {
		let steamid2 = Helpers.steamID(friendSteamId).toString();
		let count = options.maxCount || 100;
		let bbcode_format = options.wantBbcode !== false;
		let rtime32_start_time = options.startTime ? convertDateToUnix(options.startTime) : undefined;
		let start_ordinal = rtime32_start_time ? options.startOrdinal : undefined;
		let time_last = options.lastTime ? convertDateToUnix(options.lastTime) : Math.pow(2, 31) - 1;
		let ordinal_last = time_last ? options.lastOrdinal : undefined;

		let userLastViewed = 0;
		try {
			let activeSessions = await this.getActiveFriendMessageSessions();
			let friendSess;
			if (
				activeSessions.sessions &&
				(friendSess = activeSessions.sessions.find(sess => sess.steamid_friend.toString() == steamid2))
			) {
				userLastViewed = friendSess.time_last_view;
			}
		} catch (ex) {
			this.user.emit('debug', `Exception reported calling getActiveMessageSessions() inside of getFriendMessageHistory(): ${ex.message}`);
		}

		this.user._sendUnified("FriendMessages.GetRecentMessages#1", {
			"steamid1": this.user.steamID.toString(),
			steamid2,
			count,
			"most_recent_conversation": false,
			rtime32_start_time,
			bbcode_format,
			start_ordinal,
			time_last,
			ordinal_last
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.messages = body.messages.map(msg => ({
				"sender": SteamID.fromIndividualAccountID(msg.accountid),
				"server_timestamp": new Date(msg.timestamp * 1000),
				"ordinal": msg.ordinal || 0,
				"message": msg.message,
				"message_bbcode_parsed": bbcode_format ? parseBbCode(msg.message) : null,
				"unread": (msg.timestamp * 1000) > userLastViewed
			}));

			body.more_available = !!body.more_available;
			resolve(body);
		});
	});
};

/**
 * Get message history for a chat (channel).
 * @param {int|string} groupId
 * @param {int|string} chatId
 * @param {{[maxCount], [lastTime], [lastOrdinal], [startTime], [startOrdinal]}} [options]
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.getChatMessageHistory = function(groupId, chatId, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}

	return StdLib.Promises.callbackPromise(null, callback, (accept, reject) => {
		let max_count = options.maxCount || 100;
		let last_time = options.lastTime ? convertDateToUnix(options.lastTime) : undefined;
		let last_ordinal = options.lastOrdinal;
		let start_time = options.startTime ? convertDateToUnix(options.startTime) : undefined;
		let start_ordinal = options.startOrdinal;

		this.user._sendUnified("ChatRoom.GetMessageHistory#1", {
			"chat_group_id": groupId,
			"chat_id": chatId,
			last_time,
			last_ordinal,
			start_time,
			start_ordinal,
			max_count
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			body.messages = body.messages.map((msg) => {
				msg.sender = SteamID.fromIndividualAccountID(msg.sender);
				msg.server_timestamp = new Date(msg.server_timestamp * 1000);
				msg.ordinal = msg.ordinal || 0;
				msg.message_bbcode_parsed = parseBbCode(msg.message);
				msg.deleted = !!msg.deleted;
				if (msg.server_message) {
					msg.server_message.steamid_param = msg.server_message.accountid_param ? SteamID.fromIndividualAccountID(msg.server_message.accountid_param) : null;
					delete msg.server_message.accountid_param;
				}
				return msg;
			});

			body.more_available = !!body.more_available;
			accept(body);
		});
	});
};

/**
 * Acknowledge (mark as read) a friend message
 * @param {SteamID|string} friendSteamId - The SteamID of the friend whose message(s) you want to acknowledge
 * @param {Date|int} timestamp - The timestamp of the newest message you're acknowledging (will ack all older messages)
 */
SteamChatRoomClient.prototype.ackFriendMessage = function(friendSteamId, timestamp) {
	this.user._sendUnified('FriendMessages.AckMessage#1', {
		"steamid_partner": Helpers.steamID(friendSteamId).toString(),
		"timestamp": convertDateToUnix(timestamp)
	});
};

/**
 * Acknowledge (mark as read) a chat room.
 * @param {int} chatGroupId
 * @param {int} chatId
 * @param {Date|int} timestamp - The timestamp of the newest message you're acknowledging (will ack all older messages)
 */
SteamChatRoomClient.prototype.ackChatMessage = function(chatGroupId, chatId, timestamp) {
	this.user._sendUnified('ChatRoom.AckChatMessage#1', {
		"chat_group_id": chatGroupId,
		"chat_id": chatId,
		"timestamp": convertDateToUnix(timestamp)
	});
};

/**
 * Delete one or more messages from a chat channel.
 * @param {int|string} groupId
 * @param {int|string} chatId
 * @param {{server_timestamp, ordinal}[]} messages
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.deleteChatMessages = function(groupId, chatId, messages, callback) {
	return StdLib.Promises.callbackPromise(null, callback, true, (accept, reject) => {
		if (!Array.isArray(messages)) {
			return reject(new Error('The \'messages\' argument must be an array'));
		}

		for (let i = 0; i < messages.length; i++) {
			if (!messages[i] || typeof messages[i] !== 'object' || (!messages[i].server_timestamp && !messages[i].timestamp)) {
				return reject(new Error('The \'messages\' argument is malformed: must be an array of objects with properties {(server_timestamp|timestamp), ordinal}'));
			}
		}

		messages = messages.map((msg) => {
			let out = {};

			msg.ordinal = msg.ordinal || 0;
			if (msg.timestamp && !msg.server_timestamp) {
				msg.server_timestamp = msg.timestamp;
			}

			out.server_timestamp = convertDateToUnix(msg.server_timestamp);

			if (msg.ordinal) {
				out.ordinal = msg.ordinal;
			}

			return out;
		});

		this.user._sendUnified("ChatRoom.DeleteChatMessages#1", {
			"chat_group_id": groupId,
			"chat_id": chatId,
			"messages": messages
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			accept();
		});
	});
};

/**
 * Kick a user from a chat room group.
 * @param {int|string} groupId
 * @param {SteamID|string} steamId
 * @param {Date|int} [expireTime] - Time when they should be allowed to join again. Omit for immediate.
 * @param {function} [callback]
 * @returns {Promise}
 */
SteamChatRoomClient.prototype.kickUserFromGroup = function(groupId, steamId, expireTime, callback) {
	return StdLib.Promises.callbackPromise(null, callback, true, (accept, reject) => {
		this.user._sendUnified("ChatRoom.KickUserFromGroup#1", {
			"chat_group_id": groupId,
			"steamid": Helpers.steamID(steamId).toString(),
			"expiration": expireTime ? convertDateToUnix(expireTime) : Math.floor(Date.now() / 1000)
		}, (body, hdr) => {
			let err = Helpers.eresultError(hdr.proto.eresult);
			if (err) {
				return reject(err);
			}

			accept();
		});
	});
};






/**
 * Process a chat room summary pair.
 * @param {object} summaryPair
 * @param {boolean} [preProcessed=false]
 * @returns {object}
 */
function processChatRoomSummaryPair(summaryPair, preProcessed) {
	if (!preProcessed) {
		summaryPair = preProcessObject(summaryPair);
	}

	summaryPair.group_state = processUserChatGroupState(summaryPair.user_chat_group_state, true);
	summaryPair.group_summary = processChatGroupSummary(summaryPair.group_summary, true);
	delete summaryPair.user_chat_group_state;
	return summaryPair;
}

/**
 * Process a chat group summary.
 * @param {object} groupSummary
 * @param {boolean} [preProcessed=false]
 * @returns {object}
 */
function processChatGroupSummary(groupSummary, preProcessed) {
	if (!preProcessed) {
		groupSummary = preProcessObject(groupSummary);
	}

	if (groupSummary.top_members) {
		groupSummary.top_members = groupSummary.top_members.map(accountid => SteamID.fromIndividualAccountID(accountid));
	}

	return groupSummary;
}

function processChatGroupState(state, preProcessed) {
	if (!preProcessed) {
		state = preProcessObject(state);
	}

	state.chat_rooms = state.chat_rooms.map(v => processChatRoomState(v, true));
	return state;
}

function processUserChatGroupState(state, preProcessed) {
	if (!preProcessed) {
		state = preProcessObject(state);
	}

	state.user_chat_room_state = processUserChatRoomState(state.user_chat_room_state, true);
	state.unread_indicator_muted = !!state.unread_indicator_muted;
	return state;
}

function processUserChatRoomState(state, preProcessed) {
	if (!preProcessed) {
		state = preProcessObject(state);
	}

	state.unread_indicator_muted = !!state.unread_indicator_muted;
	return state;
}

function processChatRoomState(state, preProcessed) {
	if (!preProcessed) {
		state = preProcessObject(state);
	}

	state.voice_allowed = !!state.voice_allowed;
	state.members_in_voice = state.members_in_voice.map(m => SteamID.fromIndividualAccountID(m));
	return state;
}

function processChatMentions(mentions) {
	if (!mentions) {
		return mentions;
	}

	if (mentions.mention_accountids) {
		mentions.mention_steamids = mentions.mention_accountids.map(acctid => SteamID.fromIndividualAccountID(acctid));
		delete mentions.mention_accountids;
	}

	return mentions;
}

/**
 * Pre-process a generic chat object.
 * @param {object} obj
 * @returns {object}
 */
function preProcessObject(obj) {
	for (let key in obj) {
		if (!obj.hasOwnProperty(key)) {
			continue;
		}

		let val = obj[key];
		if (key.match(/^steamid_/) && typeof val === 'string' && val != '0') {
			obj[key] = new SteamID(val.toString());
		} else if (key == 'timestamp' || key.match(/^time_/) || key.match(/_timestamp$/)) {
			if (val === 0) {
				obj[key] = null;
			} else if (val !== null) {
				obj[key] = new Date(val * 1000);
			}
		} else if (key == 'clanid' && typeof val === 'number') {
			let id = new SteamID();
			id.universe = SteamID.Universe.PUBLIC;
			id.type = SteamID.Type.CLAN;
			id.instance = SteamID.Instance.ALL;
			id.accountid = val;
			obj[key] = id;
		} else if ((key == 'accountid' || key.match(/^accountid_/) || key.match(/_accountid$/)) && (typeof val === 'number' || val === null)) {
			let newKey = key == 'accountid' ? 'steamid' : key.replace('accountid_', 'steamid_').replace('_accountid', '_steamid');
			obj[newKey] = val === 0 || val === null ? null : SteamID.fromIndividualAccountID(val);
			delete obj[key];
		} else if (key.includes('avatar_sha')) {
			let url = null;
			if (obj[key] && obj[key].length) {
				url = "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/chaticons/";
				url += obj[key][0].toString(16) + '/';
				url += obj[key][1].toString(16) + '/';
				url += obj[key][2].toString(16) + '/';
				url += obj[key].toString('hex') + '_256.jpg';
			}

			obj[key.replace('avatar_sha', 'avatar_url')] = url;
		} else if (key.match(/^can_/) && obj[key] === null) {
			obj[key] = false;
		} else if (isDataObject(val)) {
			obj[key] = preProcessObject(val);
		} else if (Array.isArray(val) && val.every(isDataObject)) {
			obj[key] = val.map(v => preProcessObject(v));
		}
	}

	return obj;
}

function isDataObject(val) {
	return val !== null && typeof val === 'object' && (val.constructor.name == 'Object' || val.constructor.name == '');
}

function convertDateToUnix(date) {
	if (date instanceof Date) {
		return Math.floor(date.getTime() / 1000);
	} else if (typeof date !== 'number') {
		throw new Error('Timestamp must be a Date object or a numeric Unix timestamp');
	} else if (date > 1420088400000) {
		return Math.floor(date / 1000);
	} else {
		return date;
	}
}

function parseBbCode(str) {
	if (typeof str != 'string') {
		// Don't try to process non-string values, e.g. null
		return str;

	}
	// Steam will put a backslash in front of a bracket for a BBCode tag that shouldn't be parsed as BBCode, but our
	// parser doesn't ignore those. Let's just replace "\\[" with some string that's very improbable to exist in a Steam
	// chat message, then replace it again later.

	let replacement = Crypto.randomBytes(32).toString('hex');
	str = str.replace(/\\\[/g, replacement);

	let parsed = BBCode.parse(str, {
		"onlyAllowTags": [
			"emoticon",
			"code",
			"pre",
			"img",
			"url",
			"spoiler",
			"quote",
			"random",
			"flip",
			"tradeofferlink",
			"tradeoffer"
		]
	});

	return collapseStrings(parsed.map(processTagNode));

	function processTagNode(node) {
		if (node.tag == 'url') {
			// we only need to post-process attributes in url tags
			for (let i in node.attrs) {
				if (node.attrs[i] == i) {
					// The URL argument gets parsed with the name as its value
					node.attrs.url = node.attrs[i];
					delete node.attrs[i];
				}
			}
		}

		if (node.content) {
			node.content = collapseStrings(node.content.map(processTagNode));
		}

		return node;
	}

	function collapseStrings(arr) {
		// Turn sequences of strings into single strings
		let strStart = null;
		let newContent = [];
		for (let i = 0; i < arr.length; i++) {
			if (typeof arr[i] === 'string') {
				arr[i] = arr[i].replace(new RegExp(replacement, 'g'), '['); // only put in the bracket without the backslash because this is now "parsed"
				if (strStart === null) {
					// This is a string item and we haven't found the start of a string yet
					strStart = i;
				}
			}

			if (typeof arr[i] !== 'string') {
				// This is not a string item
				if (strStart !== null) {
					// We found the end of a string
					newContent.push(arr.slice(strStart, i).join(''));
				}

				newContent.push(arr[i]); // push this item (probably a TagNode)
				strStart = null;
			}
		}

		if (strStart !== null) {
			newContent.push(arr.slice(strStart, arr.length).join(''));
		}

		return newContent;
	}
}
