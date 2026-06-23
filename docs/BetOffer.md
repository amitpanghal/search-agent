# Bet Offer

A bet offer belongs to one specific event. Example of a bet offer is "Who will win?" or "Over/Under 2.5 goals during first half".

Bet offer is a combination of betting type and criterion for one or several outcomes with associated odds exists.

Criterion
Suspension
CashOut
Tags
Main bet offer
Main line bet offer
Bet Offer Categories
Bet Offer Types
1 - Handicap
2 - 1 x 2
3 - Result
4 - Outright
6 - Over/Under
7 - Asian Handicap
8 - HalfTime/FullTime
9 - Side bet
10 - Odd/Even
11 - Three way HCP
12 - Double Chance
13 - Head to Head
17 - Scorer
18 - Yes/No
19 - MultiPosition
21 - Asian Over/Under
117 - Position
124 - Winning Margin
125 - Player Occurrence Number
126 - Player Last Occurrence
127 - Player Occurrence Line
128 - Occurrence Method

# Criterion

A criterion describes the bet offer, what a player is offered to bet on.

The criterion attempts to describe:

when the bet offer is valid
when the bet offer ends
if something is counted, what is counted and when to stop
For a football game "Full time" means that the player is offered to bet on a set of outcomes for the full time of the game e.g. Who will win the match?

In a volleyball game the criterion "Set 2 - First to 5 points" is exactly what it sounds like. Set 2 is the lifetime, points are being counted and the bet is won or lost when either team score 5 points.

Note
The criterion has an id and a descriptive string. The criterion id is:

groupable (it is possible to use the criterion to group similar bet offers)
not comparable (might sometimes be same but can also be different for a seemingly same criterion)
not sortable (for instance it might seem that criterion might sort based on lifetime, use sortOrder for sorting)
Suspension
A bet offer can be suspended, which means that it is not possible to place any bets on its outcomes, but they can still be displayed. This is indicated on the bet offer by having suspended=true.

Suspension can also be done on individual outcome, through the outcome status.

# CashOut

If a placed bet is possible to cash out (and to what value) is given by the Player API. In the Offering API it is indicated current cash out possibility in advance before the bet is placed. Although it might change after bet is placed.

A bet offer's (or rather bets on its outcomes) CashOutStatus can be either ENABLED, SUSPENDED (temporarily disabled during trading) or DISABLED (more permanently, although it can be enabled later on).

CashOutStatus exists on both bet offer and outcome level and both have to be taken into consideration. Read more on the outcome page.

# Tags

Bet offers contain a list of tags describing it.

Values might include but are not limited to:

Tag Description
OFFERED_LIVE The bet offer will be offered live.
OFFERED_PREMATCH The bet offer will be offered prematch.
MAIN The bet offer is the main bet offer within the event (see below)
NOT_COMBINABLE The bet offer can not be combined with other bet offers when placing bets. If tag is omitted the bet offer can be combined with other bet offers.
STARTING_PRICE The odds of the bet offer will be set during settling. The odds for this bet offer will be returned as -1.
PBA_DISABLED Partial Bet Approval is not available for this bet offer.
RULE4 Rule 4 applies to the bet offer. See the official terms and conditions for the description of Rule 4.
ENHANCED_PLACE_TERMS The bet offer has enhanced place terms (horse racing)
MAIN_LINE The bet offer line with outcome odds closest to each other (see below)
Main bet offer
The bet offer having MAIN tag is the primary bet offer for the event it belongs to. For a given match or competition event, it is usually the bet offer with winner criterion. The bet offer with MAIN tag may vary during the lifecycle of an event, for an example when the event changes state from pre-match to live. Although for most events the bet offer having MAIN tag will remain the same.

There is no guarantee that any bet offer has MAIN tag amongst all bet offers for a given event. For example, if the bet offer with winner criterion is taken off-site.

On landing page or list-view (when requested for multiple sports or competitions), it is the main bet offer which is returned in the response.

Main line bet offer
For line markets (handicap, over/under etc), there are separate bet offers for each line value. Among the bet offers with same bet offer type, criterion and criterion arguments, there will be one bet offer having the tag MAIN_LINE. That bet offer is the most even bet offer, the one with its outcome odds closest to each other.

Exception to the above is for North American offerings, for which in Ice Hockey and Baseball full time handicap, the MAIN_LINE tag is instead set on the bet offer having the favourite -1.5 goals/runs. If the game is totally even the home team will count as favorite. If favourite changes, the tag will move to other bet offer. If that bet offer is not available, then the most even bet offer will be tagged as MAIN_LINE.

On list-view etc., for line bet offers, it is the bet offer being the main line which is displayed.

# Bet Offer Categories

Bet Offer Categories are used to group and sort bet offers for different purposes in the system. For example deciding which bet offer is the "main" bet offer for an event or for grouping/sorting bet offers in the client. Some resources in the API also allows filtering bet offers, based on category group names.

There are three levels of mappings and settings that come into play:

BetOfferCategory Group
|
+--- BetOfferCategory
|
+---BetOfferCategory-mapping
A BetOfferCategory group has a name and is either for live or for prematch and contains many BetOfferCategories. A BetOfferCategory is for a specific sport and has a sortorder to be sorted in the BetOfferCategoryGroup. Each BetOfferCategory have one to many mappings. A mapping is for a specific betOffer-type and criterion id and has a sortorder to be sorted within the BetOfferCategory

It is not possible to modify the category groups or change the sort order, that can only be done by Kambi.

Available Bet Offer Category Groups
Category Group name Description
combined_layout _ used to create the combined layout in the list view
instant_betting used for the Instant betting categorization in the live event view in the client.
list_view _ used to control what bet offers to show in the list view (for matches).
list_view_competitions used to control what bet offers to show in the list view (for competitions).
live_event _ used to group and sort bet offers in the live event view in the client
pre_match_event _ used to group and sort bet offers in the prematch event view in the client
selected_live _ used to group and sort bet offers in the live event view in the client
selected_pre_match _ used to group and sort bet offers in the prematch event view in the client
main_live_bet_offer _ used to decide what live bet offer that is main for an event (see above)
main_pre_match_bet_offer _ used to decide what pre match bet offer that is main for an event (see above)
extended_event_push used to decide what live bet offers should be included in Extended Event Push (apart from main_live_bet_offer and combined_layout)

- Configured slightly differently for US offerings compared to non-US offerings.

# Bet Offer Types

Each bet offer (also known as "market") has exactly one type.

An event can have multiple bet offers of the same bet offer type. It is also possible to have multiple bet offers with the same criterion (but with different criterion arguments).

The API exposes the following bet offer IDs. The API might send out other IDs, the client should then ignore that bet offer.

# Outcomes

All outcomes have common attributes like type, englishLabel, label plus general data like id, odds, status etc. See API for details.

There is no guaranteed order of the outcomes within one bet offer. For outcomes which are part of match events, it is recommended that the client do the desired sorting based on type field on the outcome (different possible values for each bet offer type). In case its event's tag-element contains AWAY_HOME, for bet offers containing both sides, the outcomes may be sorted in reverse order, to present outcomes related to away participant first.

The text below describes the specific attributes and differences per bet offer type the outcome is included in. The numeric id is the id of the betOfferType in API response and also the valid values for the filtering request parameter type.

# 1 - Handicap

Description
"Handicap" is where it is possible to bet on whether the chosen outcome will be victorious once the listed handicap is added/subtracted (as applicable) to the match/period/total score to which the bet refers to. In those circumstances where the result after the adjustment of the handicap line is exactly equal to the betting line, then all bets on this offer will be declared void. Example: a bet on -3.0 goals will be declared void if the team chosen wins the match by exactly 3 goals difference (3-0,4-1, 5-2, etc).

API
Specific attributes on the two outcomes (fewer outcomes if suspended etc).

type englishLabel label participantId participant line
OT_ONE "1" localized text of "1" id of home team localized name of home team line handicap (see text)
OT_TWO "2" localized text of "2" id of away team localized name of away team line handicap (see text)
OT_ONE represents home team and OT_TWO represents away team.

Additional attribute on each outcome is line which indicates the actual handicap, multiplied by 1 000. Note that the line values of the two outcomes have opposite signs (as compared with 11 - Three way HCP, which always presents the line from home participant perspective). Usually the line is ending in 500 (so no bets can be voided due to "tie").

# 2 - 1 x 2

Description
"Match" (aka 1X2) is where it is possible to bet on the (partial or definite) outcome of a match or event. The possible outcomes are Home (OT_ONE), Draw (OT_CROSS) or Away (OT_TWO).

The labels on the bet offer's outcomes may be of one of two different styles. Either participant name representing that outcome or static labels "1", "X" and "2". Which style is used, depends mostly on sport and how the event is traded by Kambi. The style with participant name, also contains the participant id for that participant.

API
Specific attributes on the three outcomes (fewer outcomes if suspended or match can't be a draw etc).

Style - Participant labels
type englishLabel label participantId participant
OT_ONE English name of home participant localized name of home participant id of home participant localized name of home participant
OT_CROSS "X" localized text of "X" (not set) (not set)
OT_TWO English name of away participant localized name of away participant id of away participant localized name of away participant
Style - Static 1X2 labels
type englishLabel label participantId participant
OT_ONE "1" localized text of "1" (not set) (not set)
OT_CROSS "Draw" localized text of "Draw" (not set) (not set)
OT_TWO "2" localized text of "2" (not set) (not set)

# 3 - Result

Description
"Correct Score" (aka Result Betting) is where it is possible to bet on the (partial or definite) exact score of a match or event.

API
Each different result is represented by one outcome in the same bet offer. (However of course different bet offers for different criteria, e.g. full-time and half-time are different Result bet offers.)

Specific attributes on the any number of outcomes.

type englishLabel label
OT_UNTYPED Home score - Away score Home score - Away score
OT_UNTYPED Home score - Away score Home score - Away score
OT_UNTYPED Home score - Away score Home score - Away score
... ... ...
For events which have the tag AWAY_HOME, the label will be reversed, showed as "Away score - Home Score". The english label (used for analytics) will still have the format "Home score - Away score".

# 4 - Outright

Description
"Outright" or "Place" betting is where it is possible to choose from a list of alternatives and bet on the eventuality that a participant wins or places within a specified position in the classification of the listed event/competition.

Gallops, without favourite
For gallops, along with winner outright bet offer, there might be additional best position outrights. These are namely the one excluding the top favourite participant or excluding the top two favourite participants. These two other bet offers have different (lower) odds, label and criterionId compared to the winner outright. The top favourite participant for an event is identified by the favouriteType having either FIRST or SECOND which indicates the top or the second favourite participant respectively. The race favourites can change, and in that case new bet offers are created. NOTE: The criterionIds used in test can be different compared to production.

Participant - FavouriteType Regular outright "Without Favourite" outright "Without Fav/2Fav" outright
Top favourite - FIRST outcome available no outcome no outcome
Second favourite - SECOND outcome available outcome available no outcome
all others - not set outcome available outcome available outcome available
API
Specific attributes on any number of outcomes.

type englishLabel label participantId
OT_UNTYPED English name of participant Localized name of participant Id of participant
Additional attribute placeLimit on the bet offer which indicates the least accepted position for a participant. E.g. placeLimit="3" means position 1-3, placeLimit="1" means only winner etc.

Whenever placeLimit field is set, the bet offer label may be different between the bet offers belonging to the same event and having the same criterion, but with different placeLimit values.

Note that "Any other" is treated as one normal participant, usually with just the label "Any other".

Note that it is similar to 117 - Position.

# 6 - Over/Under

Description
"Over/Under" (aka Totals) is where it is possible to bet on the (partial or definite) amount of a predefined occurrence (e.g. goals, points, corners, rebounds, penalty minutes, etc.). Should the total amount of the listed occurrences be exactly equal to the betting line, then all bets on this offer will be declared void. Example: an offer where the betting line is 128.0 points and the match ends with the result 64-64 will be declared void.

API
Specific attributes on the two outcomes (fewer outcomes if suspended etc).

type englishLabel label line
OT_OVER "Over" localized text of "Over" line (see text)
OT_UNDER "Under" localized text of "Under" line (see text)
Additional attribute on each outcome is line which indicates the drawing line between over and under. For most sports and occurrences, it is multiplied by 1 000 and usually ends in 500 (then bets can't be voided due to "tie").

# 7 - Asian Handicap

Description
See description for 1 - Handicap.

Asian means the bet stake is split into two equals halves, one below the bet offer line, and one above the bet offer line.

API
Same structure as 1 - Handicap.

Usually the line is ending in only 250 or 750 (to act as asian and no bets can be voided as "tie"). Note that the lines of the two outcomes have opposite signs.

Each pair of outcomes (with opposite line values), are represented as one separate bet offer.

# 8 - HalfTime/FullTime

Description
"Half time/Full time" is where it is possible to bet on the result in half time and the final outcome of the match. E.g. if at Half time the score is 1-0 and the match ends 1-1, the winning outcome is 1/X. The bet is void if the regular time of the match is played in a different time format than those listed in the bet (i.e. other than two halves).

API
Specific attributes on the nine outcomes (fewer outcomes if suspended, first half is completed etc).

type englishLabel label
OT_ONE_ONE "1/1" localized text of "1/1"
OT_ONE_CROSS "1/X" localized text of "1/X"
OT_ONE_TWO "1/2" localized text of "1/2"
OT_CROSS_ONE "X/1" localized text of "X/1"
OT_CROSS_CROSS "X/X" localized text of "X/X"
OT_CROSS_TWO "X/2" localized text of "X/2"
OT_TWO_ONE "2/1" localized text of "2/1"
OT_TWO_CROSS "2/X" localized text of "2/X"
OT_TWO_TWO "2/2" localized text of "2/2"
E.g. OT_ONE_ONE represents home team halftime and fulltime, OT_TWO_CROSS represents away team halftime and then draw at fulltime etc.

# 9 - Side bet

Description
1 x 2 but other criteria like "who to reach most aces?". Rare usage.

API
Same structure as 2 - 1 x 2.

# 10 - Odd/Even

Description
"Odd/Even" is where it is possible to bet on the (partial or definite) amount of a predefined occurrence (e.g. goals, points, corners, rebounds, penalty minutes, etc.)."Odd" is 1, 3, 5 etc.; "Even" is 0, 2, 4 etc.

API
Specific attributes on the two outcomes (fewer outcomes if suspended etc).

type englishLabel label
OT_EVEN "Even" localized text of "Even"
OT_ODD "Odd" localized text of "Odd"

# 11 - Three way HCP

Three way handicap (aka European handicap) is a three-way with an adjustment for a handicap line.

Description
API
Similar structure as 1 - Handicap, but it also allows draw. The three outcome types are OT_ONE, OT_CROSS and OT_DRAW (while 1 - Handicap has only OT_ONE and OT_TWO).

Note that the OT_ONE and OT_TWO (and OT_CROSS) "line" values are identical within the very same bet offer, always from the home participant perspective, while 1 - Handicap which has opposite "line" values for OT_ONE and OT_TWO.

If it is desired to display the line from the away participant perspective for the OT_TWO outcome, then negate its line value.

# 12 - Double Chance

Description
"Double Chance" is where it is possible to bet simultaneously on two (partial or definite) outcomes of a match or event. The options are: 1X, 12 and X2 with "1", "X" and "2"

API
Specific attributes on the three outcomes (fewer outcomes if suspended etc).

type englishLabel label
OT_ONE_OR_CROSS "1X" localized text of "1X"
OT_ONE_OR_TWO "12" localized text of "12"
OT_CROSS_OR_TWO "X2" localized text of "X2"
OT_ONE_OR_CROSS represents either home participant or a draw. OT_ONE_OR_TWO represents either home participant or away participant. OT_CROSS_OR_TWO represents either draw or away participant.

# 13 - Head to Head

Description
A "Head-to-Head" is a competition between two participants/outcomes, originating from either an officially organised event, or else, as virtually defined.

API
STYLE - Yes / No
Specific attributes on the two outcomes (fewer outcomes if suspended etc).
type englishLabel label participantId participant
OT_YES "Yes" localized text of "Yes" Id of home participant Localized name of home participant
OT_NO "No" localized text of "No" (Optional) Id of away participant (Optional) Localized name of away participant
STYLE - Participant
Unspecified number of outcomes
type englishLabel label participantId participant
OT_UNTYPED Name of participant Localized name of participant Id of participant Localized name of participant
OT_UNTYPED Custom label Localized Custom label (not set) (not set)

# 17 - Scorer

Description
A bet offer based on a participant to achieve something (e.g. to score a goal).

API
Specific attributes on the outcomes.

type criterion englishLabel label
OT_UNTYPED criterion (see text) English name of participant localized name of participant
The criterion element consists of two attributes, type (numeric id) and name (localized name of criterion).

Each criterion and participant are outcomes within the same bet offer (not separate bet offer).

# 18 - Yes/No

Description
A Yes/No bet offer is betting for or against a statement. For example, “Will it snow tomorrow?”

API
Specific attributes on the two outcomes (fewer outcomes if suspended etc.).

type englishLabel label
OT_YES "Yes" localized text of "Yes"
OT_NO "No" localized text of "No"

# 19 - MultiPosition

Description
API
This bet offer has only one single dummy outcome. Instead, the API user should base bet offer/outcomes on the participants within the event belonging to the bet offer. The bet offer contains the bet offer "placeLimit" to indicate how many participants should be selected in a multi-position bet.

This bet offer is only used for horse racing and greyhounds.

Attributes on dummy outcome.
type englishLabel label
OT_UNTYPED "MultiPosition" localized text of "MultiPosition"

# 21 - Asian Over/Under

Description
See description for 6 - Over/Under.

Asian means the bet stake is split into two equals halves, one below the bet offer line, and one above the bet offer line.

API
Same structure as 6 - Over/Under.

A specific additional attribute on both outcomes is line (both outcomes have the same value) which indicates the actual asian handicap, multiplied by 1 000. Usually the line is ending in 250 or 750 (to act as asian and no bets can be voided as "tie").

Each different line is returned as separate bet offers.

# 117 - Position

Description
See 4 - Outright for description

API
type englishLabel label participantId
OT_UNTYPED English name of participant Localized name of participant Id of participant
Additional attributes from and to on the bet offer which indicates the first and last accepted position (e.g., from=1 and to=3 means place 1-3, from=1 and to=1 means only winner).

Note that "Any other" is treated as one normal participant, usually with just the label "Any other".

Note that it is similar to 4 - Outright.

# 124 - Winning Margin

Description
A Winning Margin is a bet offer were one chooses what team to win and what goals/points margin the winning team will have.

Winning Margin bet offers were previously modelled with the Outright bet offer type. Note that Outright bet offer type is used for several different betoffers. Hence, the type will not be replaced fully by the new Winning Margin bet offer type.

API
type englishLabel label lowerLimit upperLimit
OT_WM_HOME_WIN_EXACT Home team to win by {lowerLimit} Localized home team to win by {lowerLimit} The lower limit The upper limit
OT_WM_AWAY_WIN_EXACT Away team to win by {lowerLimit} Localized away team to win by {lowerLimit} The lower limit The upper limit
OT_WM_EITHER_WIN_EXACT Either team to win by {lowerLimit} Localized either team to win by {lowerLimit} The lower limit The upper limit
OT_WM_HOME_WIN_ABOVE Home team to win by more than {lowerLimit} Localized home team to win by more than {lowerLimit} The lower limit N/A
OT_WM_AWAY_WIN_ABOVE Away team to win by more than {lowerLimit} Localized away team to win by more than {lowerLimit} The lower limit N/A
OT_WM_EITHER_WIN_ABOVE Either team to win by more than {lowerLimit} Localized either team to win by more than {lowerLimit} The lower limit N/A
OT_WM_MARGIN_HOME_WIN_SAME_OR_ABOVE Home team to win by {lowerLimit} or more Localized home team to win by {lowerLimit} or more The lower limit N/A
OT_WM_AWAY_WIN_SAME_OR_ABOVE Away team to win by {lowerLimit} or more Localized away team to win by {lowerLimit} or more The lower limit N/A
OT_WM_EITHER_WIN_SAME_OR_ABOVE Either team to win by {lowerLimit} or more Localized either team to win by {lowerLimit} or more The lower limit N/A
OT_WM_HOME_WIN_BELOW Home team to win by less than {upperLimit} Localized home team to win by less than {upperLimit} N/A The upper limit
OT_WM_AWAY_WIN_BELOW Away team to win by less than {upperLimit} Localized away team to win by less than {upperLimit} N/A The upper limit
OT_WM_EITHER_WIN_BELOW Either team to win by less than {upperLimit} Localized either team to win by less than {upperLimit} N/A The upper limit
OT_WM_EITHER_WIN_BELOW_OR_DRAW Either team to win by less than {upperLimit} (incl. Draw) Localized either team to win by less than {upperLimit} (incl. Draw) N/A The upper limit
OT_WM_HOME_WIN_SAME_OR_BELOW Home team to win by {upperLimit} or less Localized home team to win by {upperLimit} or less N/A The upper limit
OT_WM_AWAY_WIN_SAME_OR_BELOW Away team to win by {upperLimit} or less Localized away team to win by {upperLimit} or less N/A The upper limit
OT_WM_EITHER_WIN_SAME_OR_BELOW Either team to win by {upperLimit} or less Localized either team to win by {upperLimit} or less N/A The upper limit
OT_WM_EITHER_WIN_SAME_OR_BELOW_OR_DRAW Either team to win by {upperLimit} or less (incl. Draw) Localized either team to win by {upperLimit} or less (incl. Draw) N/A The upper limit
OT_WM_HOME_WIN_RANGE Home team to win by {lowerLimit}-{upperLimit} Localized home team to win by {lowerLimit}-{upperLimit} The lower limit The upper limit
OT_WM_AWAY_WIN_RANGE Away team to win by {lowerLimit}-{upperLimit} Localized away team to win by {lowerLimit}-{upperLimit} The lower limit The upper limit
OT_WM_EITHER_WIN_RANGE Either team to win by {lowerLimit}-{upperLimit} Localized either team to win by {lowerLimit}-{upperLimit} The lower limit The upper limit
OT_WM_DRAW Draw Localized Draw N/A N/A
OT_WM_SCORE_DRAW Score Draw Localized Score Draw N/A N/A
OT_WM_SCORELESS_DRAW 0-0 Draw Localized 0-0 Draw N/A N/A
Additional attributes lowerLimit and upperLimit on the outcome which indicates the lower and/or upper limit depending on outcome type (e.g. for the outcome type OT_WM_HOME_WIN_RANGE lowerLimit=1 and upperLimit=6 means a winning outcome if the home team wins by 1-6 goals).

# 125 - Player Occurrence Number

Description
A Player Occurrence Number is a bet offer on which player will do the Nth occurrence of a specific activity. E.g. "who will score first goal in the match", "who will do the next throw-in", "who will take the third free-kick in second quarter" etc. One bet offer contains multiple participants.

API
Specific attributes on the any number of outcomes.

type englishLabel label participantId
OT_PLAYER_PARTICIPANT English name of participant1 Localized name of participant1 Id of participant1
OT_PLAYER_PARTICIPANT English name of participant2 Localized name of participant2 Id of participant2
OT_PLAYER_PARTICIPANT English name of participant3 Localized name of participant3 Id of participant3
.... ............ ..... .............
OT_ANY_OTHER_PARTICIPANT "Any unlisted player in 'Home-team name'" Localized translation of the english text (not set)
OT_ANY_OTHER_PARTICIPANT "Any unlisted player in 'Away-team name'" Localized translation of the english text (not set)
OT_ANY_OTHER_PARTICIPANT "Any unlisted player" Localized translation of the english text (not set)
OT_PLAYER_OWN_GOAL "Own goal" Localized translation of the english text (not set)
OT_NO_GOAL "No goals in the match" Localized translation of the english text (not set)
OT_ANY_PARTICIPANT "Any unlisted player in 'Home-team name'" Localized translation of the english text Id of home-team participant
OT_ANY_PARTICIPANT "Any unlisted player in 'Away-team name'" Localized translation of the english text Id of away-team participant
Additional attribute eventParticipantId on the outcome which indicates the Id of the team the player (or "any other") is member of. The teams involved in an event is available in the event structure as EventParticipants.

Within the criterion field, what kind of occurrence is given in occurrenceType, the period/interval the bet offer applies to is given in lifetime and number of occurrences is given in occurrenceNumber

The optional OT_ANY_OTHER_PARTICIPANT may occur and represents the outcomes that none of the explicit given players will be the person achieving the Nth occurrence. If eventParticipantId is set it is within the corresponding team, while if it is not set, it represents all of the players, regardless which team they are playing in.

The similar optional OT_ANY_PARTICIPANT is always team specific and participantId is set to the id of the corresponding team. The field homeTeamMember is set to true when it represents any participant in home team, while it is false if it represents any participant in away team.

# 126 - Player Last Occurrence

Description
A Player Last Occurrence is a bet offer on which player will do the last occurrence of a specific activity. E.g. "Who will score the last goal in the match". One bet offer contains multiple participants.

API
Specific attributes on the any number of outcomes.

type englishLabel label participantId
OT_PLAYER_PARTICIPANT English name of participant1 Localized name of participant1 Id of participant1
OT_PLAYER_PARTICIPANT English name of participant2 Localized name of participant2 Id of participant2
OT_PLAYER_PARTICIPANT English name of participant3 Localized name of participant3 Id of participant3
.... ............ ..... .............
OT_ANY_OTHER_PARTICIPANT "Any unlisted player in 'Home-team name'" Localized translation of the english text (not set)
OT_ANY_OTHER_PARTICIPANT "Any unlisted player in 'Away-team name'" Localized translation of the english text (not set)
OT_PLAYER_OWN_GOAL "Own goal" Localized translation of the english text (not set)
OT_NO_GOAL "No goals in the match" Localized translation of the english text (not set)
OT_ANY_PARTICIPANT "Any unlisted player in 'Home-team name'" Localized translation of the english text Id of home-team participant
OT_ANY_PARTICIPANT "Any unlisted player in 'Away-team name'" Localized translation of the english text Id of away-team participant
Additional attribute eventParticipantId on the outcome which indicates the ID of the team the player (or "any other") is member of. The teams involved in an event is available in the event structure as EventParticipants.

Within the criterion field, what kind of occurrence is given in occurrenceType, the period/interval the bet offer applies to is given in lifetime.

The optional OT_ANY_OTHER_PARTICIPANT may occur and represents the outcomes that none of the explicit given players will be the person achieving the last occurrence. If eventParticipantId is set it is within the corresponding team, while if it is not set, it represents all of the players, regardless which team they are playing in.

The similar optional OT_ANY_PARTICIPANT is always team specific and participantId is set to the id of the corresponding team. The field homeTeamMember is set to true when it represents any participant in home team, while it is false if it represents any participant in away team.

# 127 - Player Occurrence Line

Description
A Player Occurrence Line is a bet offer that a specific player will do a given activity, over or under a given number of times. E.g. Number of goals, Number of interceptions. One bet offer per participant player and line.

API
Specific attributes on the two outcomes. There are two different variants of sets for this bet offer type.

YES / NO
type englishLabel label participantId
OT_YES "Yes" localized text of "Yes" Id of participant
OT_NO "No" localized text of "No" Id of participant
OVER / UNDER
type englishLabel label participantId
OT_OVER_EXACT "At least" localized text of "At least" Id of participant
OT_OVER "Over" localized text of "Over" Id of participant
OT_UNDER "Under" localized text of "Under" Id of participant
In normal usage one bet offer will only contain two outcomes, one OT_OVER_EXACT and one OT_UNDER.

Additional attribute eventParticipantId on the outcome which indicates the ID of the team the player is member of. The teams involved in an event is available in the event structure as EventParticipants.

Within the criterion field, what kind of occurrence is given in occurrenceType, the period/interval the bet offer applies to is given in lifetime and number of occurrences is given in occurrenceNumber

Additional attribute on each outcome is line which indicates the drawing line between over and under. For most sports and occurrences, it is multiplied by 1 000 and usually ends in 500 (then bets can't be voided due to "tie").

# 128 - Occurrence Method

Description
Which occurrence that may happen is represented by an Occurrence Method. E.g. First Scoring Play - Including Overtime, Result of Away Team Drive etc.

API
There are specific attributes on both bet offer and the outcomes.

type englishLabel label participantId
OT_OCCURRENCE_METHOD_FIRST English name of outcome Localized name of outcome Id of participant
Within the criterion field, what kind of occurrence is given in occurrenceType, which represents a group of different occurrences. The period/interval the bet offer applies to is given in lifetime and sequence order of the occurrence within its lifetime is occurrenceNumberInLifetime.

Additional element on each outcome is occurrence which contains occurrence type and its label. occurrenceType is the type of the specific outcome (one in the group given by the occurrenceType on the bet offer level). occurrenceTypeLabel is a translated label of that occurrenceType.

Example, occurrenceType on bet offer level might be SCORING_PLAY while the occurrenceType on outcome-level is TOUCHDOWNS, FIELD_GOALS, SAFETIES etc.
