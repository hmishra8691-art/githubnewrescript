#!/usr/bin/env node
/**
 * THE QSF FIDELITY CORPUS — representative Qualtrics exports, simple to
 * complex, written in the shape Qualtrics writes them (SurveyEntry +
 * SurveyElements; BL / FL / SQ / QO / QG / SO plus the elements Qualtrics
 * adds and Rescript ignores). Synthetic and sanitized: no client names, no
 * panel ids, no real URLs beyond example hosts — a real export can be dropped
 * beside them (see scripts/qsf-fidelity.mjs) and is measured the same way.
 *
 *   node scripts/qsf-corpus-build.mjs          writes packages/import/corpus/qsf/*.qsf
 *
 * The files are committed; this script is how they were made and how a new
 * case is added. Every feature a file carries is listed in its header
 * comment so the expectations in expected.json can be read against it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "import", "corpus", "qsf");
mkdirSync(OUT, { recursive: true });

const sq = (survey, id, payload) => ({ SurveyID: survey, Element: "SQ", PrimaryAttribute: id, SecondaryAttribute: String(payload.QuestionText ?? "").replace(/<[^>]+>/g, "").slice(0, 40), TertiaryAttribute: null, Payload: { QuestionID: id, Language: [], DataVisibility: { Private: false, Hidden: false }, Configuration: { QuestionDescriptionOption: "UseText" }, QuestionDescription: String(payload.QuestionText ?? "").replace(/<[^>]+>/g, "").slice(0, 60), ...payload } });
const sel = (qid, choice, conj) => ({ LogicType: "Question", QuestionID: qid, QuestionIsInLoop: "no", ChoiceLocator: `q://${qid}/SelectableChoice/${choice}`, Operator: "Selected", QuestionIDFromLocator: qid, LeftOperand: `q://${qid}/SelectableChoice/${choice}`, Type: "Expression", Description: `<span class="ConjDesc">${conj ?? "If"}</span> <span class="QuestionDesc">${qid}</span> <span class="LeftOpDesc">${choice}</span> <span class="OpDesc">Is Selected</span>`, ...(conj ? { Conjuction: conj } : {}) });
const logic = (...exprs) => ({ 0: Object.fromEntries([...exprs.map((e, i) => [i, e]), ["Type", "If"]]), Type: "BooleanExpression", inPage: false });
const choices = (labels, extra = {}) => Object.fromEntries(labels.map((l, i) => [i + 1, { Display: l, ...(extra[i + 1] ?? {}) }]));
const order = (n) => Array.from({ length: n }, (_, i) => i + 1);
const req = (type = "None", more = {}) => ({ Settings: { ForceResponse: "ON", ForceResponseType: "ON", Type: type, ...more } });
const opt = (type = "None", more = {}) => ({ Settings: { ForceResponse: "OFF", Type: type, ...more } });
const block = (id, desc, qids, options = {}, type = "Standard") => ({ Type: type, Description: desc, ID: id, BlockElements: qids.map((q) => q === "|" ? { Type: "Page Break" } : { Type: "Question", QuestionID: q }), Options: { BlockLocking: "false", RandomizeQuestions: "false", ...options } });
const extras = (survey) => [
  { SurveyID: survey, Element: "PROJ", PrimaryAttribute: "CORE", SecondaryAttribute: null, TertiaryAttribute: "1.1.0", Payload: { ProjectCategory: "CORE", SchemaVersion: "1.1.0" } },
  { SurveyID: survey, Element: "STAT", PrimaryAttribute: "Survey Statistics", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { MobileCompatible: true, ID: "Survey Statistics" } },
  { SurveyID: survey, Element: "RS", PrimaryAttribute: "RS_demo", SecondaryAttribute: "Default Response Set", TertiaryAttribute: null, Payload: null },
  { SurveyID: survey, Element: "QC", PrimaryAttribute: "Survey Question Count", SecondaryAttribute: "6", TertiaryAttribute: null, Payload: null },
];
const entry = (id, name, lang = "EN") => ({ SurveyID: id, SurveyName: name, SurveyDescription: null, SurveyOwnerID: "UR_sanitized", SurveyBrandID: "sanitized", DivisionID: null, SurveyLanguage: lang, SurveyActiveResponseSet: "RS_demo", SurveyStatus: "Inactive", SurveyStartDate: "0000-00-00 00:00:00", SurveyExpirationDate: "0000-00-00 00:00:00", SurveyCreationDate: "2026-01-10 09:00:00", CreatorID: "UR_sanitized", LastModified: "2026-02-01 12:00:00", LastAccessed: "0000-00-00 00:00:00", LastActivated: "0000-00-00 00:00:00", Deleted: null });

/* ------------------------------------------------------------ 01 simple */
{
  const S = "SV_simple01";
  const qsf = {
    SurveyEntry: entry(S, "Simple Satisfaction Survey"),
    SurveyElements: [
      { SurveyID: S, Element: "BL", PrimaryAttribute: "Survey Blocks", SecondaryAttribute: null, TertiaryAttribute: null, Payload: [
        block("BL_intro", "Introduction", ["QID1"], {}, "Default"),
        block("BL_main", "Main questions", ["QID2", "QID3", "|", "QID4", "QID5", "|", "QID6"]),
        { Type: "Trash", Description: "Trash / Unused Questions", ID: "BL_trash", BlockElements: [] },
      ] },
      { SurveyID: S, Element: "FL", PrimaryAttribute: "Survey Flow", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { Type: "Root", FlowID: "FL_1", Flow: [
        { Type: "Block", ID: "BL_intro", FlowID: "FL_2" },
        { Type: "Standard", ID: "BL_main", FlowID: "FL_3" },
        { Type: "EndSurvey", FlowID: "FL_4" },
      ], Properties: { Count: 4 } } },
      sq(S, "QID1", { QuestionText: "<div>Thank you for taking part. This survey takes about 3 minutes.</div>", DataExportTag: "Intro", QuestionType: "DB", Selector: "TB", Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID2", { QuestionText: "Overall, how satisfied are you with our service?", DataExportTag: "Sat", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied"]), ChoiceOrder: order(5), Validation: req() }),
      sq(S, "QID3", { QuestionText: "Which of the following have you used in the last month?", DataExportTag: "Used", QuestionType: "MC", Selector: "MAVR", SubSelector: "TX", Choices: choices(["Online account", "Mobile app", "Phone support", "In-store help", "None of these"], { 5: { ExclusiveAnswer: true } }), ChoiceOrder: order(5), Validation: req("MinChoices", { MinChoices: "1" }) }),
      sq(S, "QID4", { QuestionText: "How many times did you contact us?", DataExportTag: "Contacts", QuestionType: "TE", Selector: "SL", Validation: req("ContentType", { ContentType: "ValidNumber", ValidNumber: { Min: "0", Max: "50", NumDecimals: "0" } }) }),
      sq(S, "QID5", { QuestionText: "Please rate each of the following.", DataExportTag: "Rate", QuestionType: "Matrix", Selector: "Likert", SubSelector: "SingleAnswer", Choices: choices(["Speed of service", "Friendliness of staff", "Value for money"]), ChoiceOrder: order(3), Answers: { 1: { Display: "Poor" }, 2: { Display: "Fair" }, 3: { Display: "Good" }, 4: { Display: "Excellent" } }, AnswerOrder: order(4), ChoiceDataExportTags: { 1: "speed", 2: "staff", 3: "value" }, Validation: req() }),
      sq(S, "QID6", { QuestionText: "Anything else you would like to tell us?", DataExportTag: "Comments", QuestionType: "TE", Selector: "ESTB", Validation: opt() }),
      { SurveyID: S, Element: "SO", PrimaryAttribute: "Survey Options", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { BackButton: "false", SaveAndContinue: "true", ProgressBarDisplay: "None", Header: "", Footer: "", EOSMessage: "", NextButton: " → ", PreviousButton: " ← " } },
      ...extras(S),
    ],
  };
  writeFileSync(join(OUT, "01-simple-satisfaction.qsf"), JSON.stringify(qsf, null, 1));
}

/* ------------------------------------------------------------ 02 screener with logic, quotas, embedded data */
{
  const S = "SV_screener02";
  const qsf = {
    SurveyEntry: entry(S, "Screener with Logic and Quotas"),
    SurveyElements: [
      { SurveyID: S, Element: "BL", PrimaryAttribute: "Survey Blocks", SecondaryAttribute: null, TertiaryAttribute: null, Payload: [
        block("BL_screen", "Screener", ["QID1", "QID2", "|", "QID3", "QID4"], {}, "Default"),
        block("BL_brands", "Brands", ["QID5", "QID6", "|", "QID7"]),
        block("BL_detail", "Detail", ["QID8", "QID9"], { RandomizeQuestions: "true" }),
        block("BL_alt", "Alternative detail", ["QID12"]),
        block("BL_close", "Close", ["QID10", "QID11"]),
        { Type: "Trash", Description: "Trash / Unused Questions", ID: "BL_trash", BlockElements: [{ Type: "Question", QuestionID: "QID99" }] },
      ] },
      { SurveyID: S, Element: "FL", PrimaryAttribute: "Survey Flow", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { Type: "Root", FlowID: "FL_1", Flow: [
        { Type: "EmbeddedData", FlowID: "FL_2", EmbeddedData: [
          { Description: "source", Type: "Custom", Field: "source", VariableType: "String", DataVisibility: [], AnalyzeText: false, Value: "" },
          { Description: "panel_id", Type: "Recipient", Field: "panel_id", VariableType: "String", DataVisibility: [], AnalyzeText: false },
          { Description: "wave", Type: "Custom", Field: "wave", VariableType: "Number", DataVisibility: [], AnalyzeText: false, Value: "3" },
          { Description: "age_group", Type: "Custom", Field: "age_group", VariableType: "String", DataVisibility: [], AnalyzeText: false, Value: "${q://QID2/ChoiceGroup/SelectedChoices}" },
        ] },
        { Type: "Block", ID: "BL_screen", FlowID: "FL_3" },
        { Type: "Branch", FlowID: "FL_4", Description: "Screen out: under 18 or no consent", BranchLogic: { 0: { 0: sel("QID1", "2"), 1: { ...sel("QID2", "1", "Or"), Description: "Or age Is Selected 1" }, Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "EndSurvey", FlowID: "FL_5", Options: { Advanced: "true", SurveyTermination: "DefaultMessage", ScreenOutResponse: "true" } }] },
        { Type: "Branch", FlowID: "FL_6", Description: "Quota full", BranchLogic: { 0: { 0: { LogicType: "Quota", QuotaID: "QO_north", Operator: "QuotaMet", Type: "Expression", Description: "If Quota North Has Been Met" }, Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "EndSurvey", FlowID: "FL_7", Options: { Advanced: "true", SurveyTermination: "DefaultMessage", ScreenOutResponse: "true" } }] },
        { Type: "Block", ID: "BL_brands", FlowID: "FL_8" },
        { Type: "Randomizer", FlowID: "FL_9", SubSet: 1, EvenPresentation: true, Flow: [{ Type: "Block", ID: "BL_detail", FlowID: "FL_10" }, { Type: "Group", FlowID: "FL_11", Description: "Alternative detail", Flow: [{ Type: "Block", ID: "BL_alt", FlowID: "FL_12" }] }] },
        { Type: "Block", ID: "BL_close", FlowID: "FL_13" },
        { Type: "EndSurvey", FlowID: "FL_14", Options: { Advanced: "true", SurveyTermination: "Redirect", EOSRedirectURL: "https://panel.example.com/complete?id=${e://Field/panel_id}" } },
      ], Properties: { Count: 14 } } },
      sq(S, "QID1", { QuestionText: "Do you agree to take part in this study?", DataExportTag: "consent", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["Yes", "No"]), ChoiceOrder: order(2), Validation: req() }),
      sq(S, "QID2", { QuestionText: "How old are you?", DataExportTag: "age", QuestionType: "MC", Selector: "DL", SubSelector: "TX", Choices: choices(["Under 18", "18–24", "25–34", "35–44", "45–54", "55+"]), ChoiceOrder: order(6), RecodeValues: { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6" }, Validation: req() }),
      sq(S, "QID3", { QuestionText: "Which region do you live in?", DataExportTag: "region", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["North", "South", "East", "West", "Other (please specify)"], { 5: { TextEntry: "true" } }), ChoiceOrder: order(5), RecodeValues: { 1: "10", 2: "20", 3: "30", 4: "40", 5: "99" }, Validation: req(), DefaultChoices: { 1: { Selected: false }, 2: { Selected: true } } }),
      sq(S, "QID4", { QuestionText: "Which of these brands are you aware of?", DataExportTag: "aware", QuestionType: "MC", Selector: "MAVR", SubSelector: "TX", Choices: choices(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "None of these"], { 7: { ExclusiveAnswer: true } }), ChoiceOrder: order(7), Randomization: { Type: "Advanced", Advanced: { FixedOrder: ["1", "RAND", "7"], RandomSubSet: ["2", "3", "4", "5", "6"], TotalRandSubset: 4, Undisplayed: ["6"] }, TotalRandSubset: "4" }, Validation: req("MinChoices", { MinChoices: "1" }) }),
      sq(S, "QID5", { QuestionText: "Which of the brands you know have you bought?", DataExportTag: "bought", QuestionType: "MC", Selector: "MAVR", SubSelector: "TX", Choices: choices(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]), ChoiceOrder: order(6), DynamicChoices: { Locator: "q://QID4/SelectedChoices", Type: "DisplayedChoices" }, DisplayLogic: { 0: { 0: { LogicType: "Question", QuestionID: "QID4", QuestionIsInLoop: "no", ChoiceLocator: "q://QID4/SelectedChoicesCount", Operator: "GreaterThanOrEqual", QuestionIDFromLocator: "QID4", LeftOperand: "q://QID4/SelectedChoicesCount", RightOperand: "2", Type: "Expression", Description: "If aware Selected Choices Count Is Greater Than or Equal to 2" }, Type: "If" }, Type: "BooleanExpression", inPage: false }, Validation: opt() }),
      sq(S, "QID6", { QuestionText: "How do you feel about each brand you bought?", DataExportTag: "feel", QuestionType: "Matrix", Selector: "Likert", SubSelector: "SingleAnswer", Choices: choices(["Alpha", "Beta", "Gamma"], { 3: { DisplayLogic: { 0: { 0: sel("QID5", "3"), Type: "If" }, Type: "BooleanExpression", inPage: false } } }), ChoiceOrder: order(3), Answers: { 1: { Display: "Dislike" }, 2: { Display: "Neutral" }, 3: { Display: "Like" } }, AnswerOrder: order(3), Validation: req(), DisplayLogic: { 0: { 0: { LogicType: "EmbeddedField", LeftOperand: "wave", Operator: "GreaterThan", RightOperand: "1", Type: "Expression", Description: "If wave Is Greater Than 1" }, Type: "If" }, Type: "BooleanExpression", inPage: false } }),
      sq(S, "QID7", { QuestionText: "Why did you choose ${q://QID5/ChoiceGroup/SelectedChoices}? (Awareness: ${q://QID4/ChoiceGroup/SelectedChoicesCount} brands)", DataExportTag: "why", QuestionType: "TE", Selector: "ML", Validation: opt("CharRange", { MinChars: "3", MaxChars: "500" }),
        SkipLogic: [{ SkipLogicID: 1, ChoiceLocator: "q://QID7/ChoiceTextEntryValue", Condition: "Empty", SkipToDestination: "ENDOFBLOCK", SkipToDestinationType: "EndOfBlock", Description: "If why Is Empty Then Skip To End of Block" }] }),
      sq(S, "QID8", { QuestionText: "How likely are you to recommend Alpha to a friend?", DataExportTag: "nps", QuestionType: "MC", Selector: "NPS", SubSelector: "TX", Choices: choices(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]), ChoiceOrder: order(11), Validation: req() }),
      sq(S, "QID9", { QuestionText: "Your email, if we may follow up", DataExportTag: "email", QuestionType: "TE", Selector: "SL", Validation: opt("ContentType", { ContentType: "ValidEmail" }), DataVisibility: { Private: true, Hidden: false } }),
      sq(S, "QID10", { QuestionText: "Which statements apply to you?", DataExportTag: "apply", QuestionType: "MC", Selector: "MAVR", SubSelector: "TX", Choices: choices(["I buy for my household", "I buy for a business", "Neither"], { 3: { ExclusiveAnswer: true } }), ChoiceOrder: order(3), Validation: opt(), SkipLogic: [{ SkipLogicID: 2, ChoiceLocator: "q://QID10/SelectableChoice/3", Condition: "Selected", SkipToDestination: "ENDOFSURVEY", SkipToDestinationType: "EndOfSurvey" }, { SkipLogicID: 3, ChoiceLocator: "q://QID10/SelectableChoice/2", Condition: "Selected", SkipToDestination: "QID42", SkipToDestinationType: "Question" }] }),
      sq(S, "QID11", { QuestionText: "Thank you. Your region: ${q://QID3/ChoiceGroup/SelectedChoices}. Panel: ${e://Field/panel_id}.", DataExportTag: "thanks", QuestionType: "DB", Selector: "TB", DisplayLogic: { 0: { 0: sel("QID99", "1"), Type: "If" }, Type: "BooleanExpression", inPage: false }, Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID12", { QuestionText: "How often do you buy from any of these brands?", DataExportTag: "freq", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["Weekly", "Monthly", "Less often"]), ChoiceOrder: order(3), Validation: req() }),
      sq(S, "QID99", { QuestionText: "Old question", DataExportTag: "old", QuestionType: "MC", Selector: "SAVR", Choices: choices(["A"]), ChoiceOrder: [1] }),
      { SurveyID: S, Element: "QO", PrimaryAttribute: "QO_north", SecondaryAttribute: "North", TertiaryAttribute: null, Payload: { ID: "QO_north", Name: "North", Occurrences: 200, Logic: { 0: { 0: sel("QID3", "1"), Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey", QuotaGroupID: "QG_region", Count: 0 } },
      { SurveyID: S, Element: "QO", PrimaryAttribute: "QO_south", SecondaryAttribute: "South", TertiaryAttribute: null, Payload: { ID: "QO_south", Name: "South", Occurrences: 200, Logic: { 0: { 0: sel("QID3", "2"), Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey", QuotaGroupID: "QG_region", Count: 0 } },
      { SurveyID: S, Element: "QO", PrimaryAttribute: "QO_young", SecondaryAttribute: "Young buyers", TertiaryAttribute: null, Payload: { ID: "QO_young", Name: "Young buyers", Occurrences: 50, Logic: { 0: { 0: sel("QID2", "2"), 1: sel("QID5", "1", "And"), Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "DoNotRecord", Count: 0 } },
      { SurveyID: S, Element: "QG", PrimaryAttribute: "QG_region", SecondaryAttribute: "Region", TertiaryAttribute: null, Payload: { ID: "QG_region", Name: "Region", Quotas: ["QO_north", "QO_south"], Selected: true, MultipleMatch: "PlaceInAll" } },
      { SurveyID: S, Element: "SO", PrimaryAttribute: "Survey Options", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { BackButton: "true", SaveAndContinue: "true", ProgressBarDisplay: "VerboseText", Header: "", Footer: "", EOSMessage: "", BallotBoxStuffingPrevention: "true" } },
      ...extras(S),
    ],
  };
  writeFileSync(join(OUT, "02-screener-logic-quotas.qsf"), JSON.stringify(qsf, null, 1));
}

/* ------------------------------------------------------------ 03 complex brand tracker */
{
  const S = "SV_tracker03";
  const lang = (es, fr, choicesEs, choicesFr, answersEs, answersFr) => ({ ES: { QuestionText: es, ...(choicesEs ? { Choices: Object.fromEntries(choicesEs.map((l, i) => [i + 1, { Display: l }])) } : {}), ...(answersEs ? { Answers: Object.fromEntries(answersEs.map((l, i) => [i + 1, { Display: l }])) } : {}) }, FR: { QuestionText: fr, ...(choicesFr ? { Choices: Object.fromEntries(choicesFr.map((l, i) => [i + 1, { Display: l }])) } : {}), ...(answersFr ? { Answers: Object.fromEntries(answersFr.map((l, i) => [i + 1, { Display: l }])) } : {}) } });
  const qsf = {
    SurveyEntry: entry(S, "Brand Tracker — Wave 3 (complex)"),
    SurveyElements: [
      { SurveyID: S, Element: "BL", PrimaryAttribute: "Survey Blocks", SecondaryAttribute: null, TertiaryAttribute: null, Payload: [
        block("BL_intro", "Intro", ["QID1", "QID2"], {}, "Default"),
        block("BL_aware", "Awareness", ["QID3", "QID4", "|", "QID5"]),
        block("BL_loop", "Per brand", ["QID6", "QID7"], { Looping: "Question", LoopingOptions: { QID: "QID3", ChoiceLocator: "q://QID3/ChoiceGroup/SelectedChoices", Randomization: "All" } }),
        block("BL_static", "Per touchpoint", ["QID8"], { Looping: "Static", LoopingOptions: { Static: { 1: { 1: "Website", 2: "web" }, 2: { 1: "Store", 2: "store" }, 3: { 1: "Call centre", 2: "call" } }, Randomization: "None" } }),
        block("BL_modA", "Module A", ["QID9", "QID10"]),
        block("BL_modB", "Module B", ["QID11", "QID12"]),
        block("BL_types", "Question types", ["QID13", "|", "QID14", "QID15", "|", "QID16", "QID17", "|", "QID18", "QID19", "|", "QID20", "QID21", "QID22"]),
        block("BL_media", "Media", ["QID23", "QID24", "QID25"]),
        block("BL_end", "Close", ["QID26", "QID27", "QID28"]),
        block("BL_orphan", "Not in flow", ["QID29"]),
        { Type: "Trash", Description: "Trash / Unused Questions", ID: "BL_trash", BlockElements: [{ Type: "Question", QuestionID: "QID98" }] },
      ] },
      { SurveyID: S, Element: "FL", PrimaryAttribute: "Survey Flow", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { Type: "Root", FlowID: "FL_1", Flow: [
        { Type: "EmbeddedData", FlowID: "FL_2", EmbeddedData: [{ Description: "country", Type: "Custom", Field: "country", VariableType: "String", Value: "" }, { Description: "cell", Type: "Custom", Field: "cell", VariableType: "String", Value: "${rand://int/1:2}" }] },
        { Type: "Authenticator", FlowID: "FL_3", PanelData: { Library: "UR_sanitized", Panel: "ML_sanitized" }, Flow: [
          { Type: "Block", ID: "BL_intro", FlowID: "FL_4" },
        ] },
        { Type: "Block", ID: "BL_aware", FlowID: "FL_5" },
        { Type: "Branch", FlowID: "FL_6", Description: "No awareness", BranchLogic: { 0: { 0: sel("QID3", "5"), Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "EndSurvey", FlowID: "FL_7", Options: { Advanced: "true", SurveyTermination: "DefaultMessage", ScreenOutResponse: "true", EOSMessage: "EOSM_screened" } }] },
        { Type: "Block", ID: "BL_loop", FlowID: "FL_8" },
        { Type: "Block", ID: "BL_static", FlowID: "FL_9" },
        { Type: "BlockRandomizer", FlowID: "FL_10", SubSet: 1, EvenPresentation: true, Flow: [{ Type: "Standard", ID: "BL_modA", FlowID: "FL_11" }, { Type: "Standard", ID: "BL_modB", FlowID: "FL_12" }] },
        { Type: "Branch", FlowID: "FL_13", Description: "Device", BranchLogic: { 0: { 0: { LogicType: "DeviceType", Operator: "IsMobile", Type: "Expression", Description: "If device is mobile" }, Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "Block", ID: "BL_types", FlowID: "FL_14" }] },
        { Type: "Block", ID: "BL_media", FlowID: "FL_15" },
        { Type: "WebService", FlowID: "FL_16", URL: "https://api.example.com/score", Method: "GET", EditBody: [], Body: {}, Headers: [], StringToEmbeddedDataFieldMap: { score: "score" } },
        { Type: "Block", ID: "BL_end", FlowID: "FL_17" },
        { Type: "EndSurvey", FlowID: "FL_18", Options: { Advanced: "true", SurveyTermination: "DefaultMessage", EOSMessage: "EOSM_thanks" } },
      ], Properties: { Count: 18 } } },
      sq(S, "QID1", { QuestionText: "<p>Welcome to the brand study.</p><p><img src=\"https://brand.example.com/images/logo.png\" alt=\"Brand logo\" /></p>", DataExportTag: "welcome", QuestionType: "DB", Selector: "TB", Validation: { Settings: { Type: "None" } }, Language: lang("<p>Bienvenido al estudio de marca.</p>", "<p>Bienvenue dans l'étude de marque.</p>") }),
      sq(S, "QID2", { QuestionText: "Which country are you in?", DataExportTag: "country_q", QuestionType: "MC", Selector: "DL", SubSelector: "TX", Choices: choices(["Spain", "France", "Other"]), ChoiceOrder: order(3), Validation: req(), Language: lang("¿En qué país está?", "Dans quel pays êtes-vous ?", ["España", "Francia", "Otro"], ["Espagne", "France", "Autre"]) }),
      sq(S, "QID3", { QuestionText: "Which of these brands have you heard of?", DataExportTag: "aware", QuestionType: "MC", Selector: "MAVR", SubSelector: "TX", Choices: choices(["Alpha", "Beta", "Gamma", "Delta", "None of these"], { 5: { ExclusiveAnswer: true } }), ChoiceOrder: [1, 2, 3, 4, 5], RecodeValues: { 1: "1", 2: "2", 3: "3", 4: "4", 5: "9" }, Randomization: { Type: "All" }, Validation: req("MinChoices", { MinChoices: "1" }), Language: lang("¿Cuáles de estas marcas conoce?", "Quelles marques connaissez-vous ?", ["Alpha", "Beta", "Gamma", "Delta", "Ninguna"], ["Alpha", "Beta", "Gamma", "Delta", "Aucune"]) }),
      sq(S, "QID4", { QuestionText: "And which is your main brand?", DataExportTag: "main", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["Alpha", "Beta", "Gamma", "Delta"]), ChoiceOrder: order(4), DynamicChoices: { Locator: "q://QID3/SelectedChoices", Type: "DisplayedChoices" }, Validation: req(), DisplayLogic: { 0: { 0: { LogicType: "Question", QuestionID: "QID3", ChoiceLocator: "q://QID3/SelectableChoice/5", Operator: "NotSelected", QuestionIDFromLocator: "QID3", LeftOperand: "q://QID3/SelectableChoice/5", Type: "Expression", Description: "If aware None Is Not Selected" }, Type: "If" }, Type: "BooleanExpression", inPage: true } }),
      sq(S, "QID5", { QuestionText: "What comes to mind when you think of ${q://QID4/ChoiceGroup/SelectedChoices}? (${q://QID3/ChoiceDescription/1} is one example; your country: ${e://Field/country}; today: ${date://CurrentDate/DS})", DataExportTag: "assoc", QuestionType: "TE", Selector: "ML", Validation: opt(),
        QuestionJS: "Qualtrics.SurveyEngine.addOnload(function(){ var that = this; jQuery('#'+this.questionId+' textarea').on('keyup', function(){ if (jQuery(this).val().length > 10) that.showNextButton(); }); Qualtrics.SurveyEngine.setEmbeddedData('assoc_len', jQuery('#'+this.questionId+' textarea').val().length); });" }),
      sq(S, "QID6", { QuestionText: "How do you rate ${lm://Field/1} on each of these?", DataExportTag: "rate", QuestionType: "Matrix", Selector: "Likert", SubSelector: "SingleAnswer", Choices: choices(["Quality", "Price", "Service", "Innovation"]), ChoiceOrder: order(4), Answers: { 1: { Display: "1 Poor" }, 2: { Display: "2" }, 3: { Display: "3" }, 4: { Display: "4" }, 5: { Display: "5 Excellent" } }, AnswerOrder: order(5), Validation: req(), Configuration: { RepeatHeaders: "middle", WhiteSpace: "ON" }, Randomization: { Type: "All" } }),
      sq(S, "QID7", { QuestionText: "How likely are you to buy ${lm://Field/1} again?", DataExportTag: "repurchase", QuestionType: "MC", Selector: "SAHR", SubSelector: "TX", Choices: choices(["Very unlikely", "Unlikely", "Likely", "Very likely"]), ChoiceOrder: order(4), Validation: req("CustomValidation", { CustomValidation: { Logic: { 0: { 0: sel("QID7", "1"), Type: "If" }, Type: "BooleanExpression" }, Message: { libraryID: "UR_sanitized", messageID: "MS_custom" } } }) }),
      sq(S, "QID8", { QuestionText: "Have you used the ${lm://Field/1} in the last 3 months? (code ${lm://Field/2})", DataExportTag: "touch", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: choices(["Yes", "No"]), ChoiceOrder: order(2), Validation: req() }),
      sq(S, "QID9", { QuestionText: "Module A: rank these attributes", DataExportTag: "rankA", QuestionType: "RO", Selector: "DND", SubSelector: "TX", Choices: choices(["Quality", "Price", "Service"]), ChoiceOrder: order(3), Validation: req("AllRanks") }),
      sq(S, "QID10", { QuestionText: "Module A: allocate 100 points", DataExportTag: "alloc", QuestionType: "CS", Selector: "HSLIDER", Choices: choices(["Alpha", "Beta", "Gamma"]), ChoiceOrder: order(3), Configuration: { CSTotal: "100", CSSliderMin: "0", CSSliderMax: "100" }, Validation: req("ChoicesTotal", { ChoiceTotal: "100", EnforceRange: null }) }),
      sq(S, "QID11", { QuestionText: "Module B: how much do you agree?", DataExportTag: "agree", QuestionType: "Slider", Selector: "HSLIDER", Choices: choices(["Alpha is modern", "Alpha is reliable"]), ChoiceOrder: order(2), Configuration: { CSSliderMin: "0", CSSliderMax: "10", GridLines: "10", NumDecimals: "1", SnapToGrid: "false", ShowValue: "true", NotApplicable: "false" }, Validation: req() }),
      sq(S, "QID12", { QuestionText: "Module B: star rating", DataExportTag: "stars", QuestionType: "Slider", Selector: "STAR", Choices: choices(["Overall"]), ChoiceOrder: [1], Configuration: { StarCount: "5", StarType: "discrete", CSSliderMin: "0", CSSliderMax: "5" }, Validation: opt() }),
      sq(S, "QID13", { QuestionText: "Contact form", DataExportTag: "form", QuestionType: "TE", Selector: "FORM", Choices: choices(["First name", "City", "Postcode"]), ChoiceOrder: order(3), Validation: opt(), Configuration: { LabelPosition: "SIDE" } }),
      sq(S, "QID14", { QuestionText: "Which word fits each brand?", DataExportTag: "words", QuestionType: "Matrix", Selector: "Likert", SubSelector: "MultipleAnswer", Choices: choices(["Alpha", "Beta"]), ChoiceOrder: order(2), Answers: { 1: { Display: "Modern" }, 2: { Display: "Classic" }, 3: { Display: "Cheap" } }, AnswerOrder: order(3), Validation: opt() }),
      sq(S, "QID15", { QuestionText: "Pick a size per product", DataExportTag: "sizes", QuestionType: "Matrix", Selector: "Likert", SubSelector: "DL", Choices: choices(["Shirt", "Shoes"]), ChoiceOrder: order(2), Answers: { 1: { Display: "S" }, 2: { Display: "M" }, 3: { Display: "L" } }, AnswerOrder: order(3), Validation: opt() }),
      sq(S, "QID16", { QuestionText: "Tell us one thing per brand", DataExportTag: "onething", QuestionType: "Matrix", Selector: "TE", SubSelector: "Short", Choices: choices(["Alpha", "Beta"]), ChoiceOrder: order(2), Columns: 1, Answers: {}, Validation: opt() }),
      sq(S, "QID17", { QuestionText: "Alpha is…", DataExportTag: "bipolar", QuestionType: "Matrix", Selector: "Bipolar", SubSelector: "SingleAnswer", Choices: { 1: { Display: "Cold", BipolarSubChoices: { 1: "Warm" } }, 2: { Display: "Old", BipolarSubChoices: { 1: "New" } } }, ChoiceOrder: order(2), Answers: { 1: { Display: "1" }, 2: { Display: "2" }, 3: { Display: "3" }, 4: { Display: "4" }, 5: { Display: "5" } }, AnswerOrder: order(5), Validation: opt() }),
      sq(S, "QID18", { QuestionText: "Compare the brands side by side", DataExportTag: "sbs", QuestionType: "SBS", Selector: "SBSMatrix", Choices: choices(["Alpha", "Beta"]), ChoiceOrder: order(2), AdditionalQuestions: { 1: { QuestionText: "Quality", QuestionType: "MC", Selector: "SAVR", Answers: { 1: { Display: "Low" }, 2: { Display: "High" } }, AnswerOrder: [1, 2] }, 2: { QuestionText: "Price", QuestionType: "MC", Selector: "SAVR", Answers: { 1: { Display: "Low" }, 2: { Display: "High" } }, AnswerOrder: [1, 2] } }, Validation: opt() }),
      sq(S, "QID19", { QuestionText: "Sort these into groups", DataExportTag: "pgr", QuestionType: "PGR", Selector: "DragAndDrop", SubSelector: "NoColumns", Choices: choices(["Fast", "Cheap", "Friendly", "Modern"]), ChoiceOrder: order(4), Groups: ["Alpha", "Beta"], Validation: opt() }),
      sq(S, "QID20", { QuestionText: "Click where you look first", DataExportTag: "heat", QuestionType: "HeatMap", Selector: "Region", Graphic: "IM_heatmap01", GraphicDescription: "Shelf photo", Validation: opt() }),
      sq(S, "QID21", { QuestionText: "Upload a photo of the product", DataExportTag: "photo", QuestionType: "FileUpload", Selector: "FileUpload", Validation: opt() }),
      sq(S, "QID22", { QuestionText: "Please sign", DataExportTag: "sign", QuestionType: "Draw", Selector: "Signature", Validation: opt() }),
      sq(S, "QID23", { QuestionText: "<p>Which pack do you prefer?</p>", DataExportTag: "pack", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: { 1: { Display: "<img src=\"https://brand.example.com/pack-a.jpg\" alt=\"Pack A\" />" }, 2: { Display: "<img src=\"https://sanitized.qualtrics.com/ControlPanel/Graphic.php?IM=IM_packb\" alt=\"Pack B\" />" }, 3: { Display: "Neither" } }, ChoiceOrder: order(3), Validation: req() }),
      sq(S, "QID24", { QuestionText: "", DataExportTag: "shelf", QuestionType: "DB", Selector: "GRB", Graphic: "IM_shelf02", GraphicDescription: "Shelf layout", Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID25", { QuestionText: "Timing", DataExportTag: "timing", QuestionType: "Timing", Selector: "PageTimer", Configuration: { MinSeconds: "0", MaxSeconds: "0" }, Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID26", { QuestionText: "Browser Meta Info", DataExportTag: "meta", QuestionType: "Meta", Selector: "Browser", Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID27", { QuestionText: "When did you last buy Alpha?", DataExportTag: "lastbuy", QuestionType: "TE", Selector: "SL", Validation: opt("ContentType", { ContentType: "ValidDate", ValidDate: { DateFormat: "mm/dd/yyyy" } }) }),
      sq(S, "QID28", { QuestionText: "Prove you are human", DataExportTag: "captcha", QuestionType: "Captcha", Selector: "V2", Validation: { Settings: { Type: "None" } } }),
      sq(S, "QID29", { QuestionText: "Orphan question", DataExportTag: "orphan", QuestionType: "MC", Selector: "SAVR", Choices: choices(["A", "B"]), ChoiceOrder: order(2), Validation: opt() }),
      sq(S, "QID98", { QuestionText: "Trashed", DataExportTag: "trashed", QuestionType: "MC", Selector: "SAVR", Choices: choices(["A"]), ChoiceOrder: [1] }),
      { SurveyID: S, Element: "QO", PrimaryAttribute: "QO_fr", SecondaryAttribute: "France", TertiaryAttribute: null, Payload: { ID: "QO_fr", Name: "France", Occurrences: 300, Logic: { 0: { 0: sel("QID2", "2"), Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey", Count: 0 } },
      { SurveyID: S, Element: "QO", PrimaryAttribute: "QO_geo", SecondaryAttribute: "GeoIP", TertiaryAttribute: null, Payload: { ID: "QO_geo", Name: "Visitors from Paris", Occurrences: 100, Logic: { 0: { 0: { LogicType: "GeoIP", Operator: "Selected", Type: "Expression", Description: "If location is Paris" }, Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey", Count: 0 } },
      { SurveyID: S, Element: "SC", PrimaryAttribute: "Scoring", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { ScoringCategories: [{ ID: "SC_1", Name: "Score 1" }], ScoringSummaryCategory: null, ScoringSummaryAfterQuestions: 0, ScoringSummaryAfterSurvey: 0, DefaultScoringCategory: "SC_1", AutoScoringCategory: null } },
      { SurveyID: S, Element: "SO", PrimaryAttribute: "Survey Options", SecondaryAttribute: null, TertiaryAttribute: null, Payload: { BackButton: "true", SaveAndContinue: "true", ProgressBarDisplay: "Text", Header: "<style>.Skin h1 { color: #333 }</style><script>window.__track = 1;</script>", Footer: "", EOSMessage: "EOSM_thanks", NextButton: "Continue", PreviousButton: "Back", SurveyExpiration: "None" } },
      ...extras(S),
    ],
  };
  writeFileSync(join(OUT, "03-brand-tracker-complex.qsf"), JSON.stringify(qsf, null, 1));
}

console.log(`wrote the QSF corpus to ${OUT}`);
