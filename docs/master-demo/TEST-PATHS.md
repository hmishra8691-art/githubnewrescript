# Test paths

Each path is a set of answers the tester enters; everything not listed can be answered freely. The route below is what the engine predicts (`simulateRespondent`), so a Test-Mode run can be checked against it page by page.

## Path A — Apple + Google + Samsung

Three brands used → LOOP_001 runs 3 times (with the nested feature loop), LOOP_003 covers the aware-but-unused brands, List Fill allocates 2.

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2,
  "q_aware": [
    1,
    2,
    3,
    4,
    6,
    9
  ],
  "q_used": [
    1,
    3,
    2
  ],
  "q_trusted": [
    1,
    3
  ],
  "q_fav_brand": 1,
  "q_years_used": {
    "1": 8,
    "2": 2,
    "3": 4
  },
  "q_detail_interest": 1,
  "q_n_products": 2
}
```

Expected:

- LOOP_001 iterates Apple, Google, Samsung in selection order
- nested LOOP_002 runs 3 features per brand
- LOOP_003 covers up to 3 of Xiaomi/Sony/Huawei
- LOOP_004 covers Huawei (market exit)
- List Fill count = 2

Predicted route (79 pages, end status **complete**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates` → `p_quota_cell` → `p_tech_usage` → `p_tech_priorities` → `p_tech_spend` → `p_tech_spend_12m` → `p_tech_sat` → `p_combined` → `p_brand_unaided` → `p_brand_aware` → `p_brand_used` → `p_brand_fav` → `p_brand_grids` → `p_brand_grids_2` → `p_brand_detail_gate` → `p_lf_eval` → `p_lf_loop@1` → `p_lf_loop@2` → `p_listops_1` → `p_listops_2` → `p_listops_3` → `p_l1_a@1` → `p_l1_b@1` → `p_l1_c@1` → `p_l2@1@battery` → `p_l2@1@camera` → `p_l2@1@price` → `p_l1_a@3` → `p_l1_b@3` → `p_l1_c@3` → `p_l2@3@battery` → `p_l2@3@camera` → `p_l2@3@price` → `p_l1_a@2` → `p_l1_b@2` → `p_l1_c@2` → `p_l2@2@battery` → `p_l2@2@camera` → `p_l2@2@price` → `p_l3@6` → `p_l3@9` → `p_l3@4` → `p_l4@9` → `p_l4@12` → `p_l6_count` → `p_l6@1` → `p_l6@2` → `p_rand_1` → `p_rand_2` → `p_rand_3` → `p_rand_experiment` → `p_att_sustain` → `p_att_privacy` → `p_calc_summary` → `p_calc_segments` → `p_val_1` → `p_val_2` → `p_cbc` → `p_cbc_follow` → `p_maxdiff` → `p_maxdiff_follow` → `p_cd@1` → `p_cd@2` → `p_cd@3` → `p_spec_grid` → `p_spec_repeat` → `p_spec_media` → `p_spec_variants` → `p_oe_1` → `p_oe_2` → `p_final`

List Fill results: lf_topic: customer service · lf_brand_eval: Apple, Samsung · lf_trust: Apple

## Path B — Apple only

One brand → single loop iteration, List Fill allocates exactly one item (count = min(2, 1)); LF_SAT_2 is hidden.

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2,
  "q_aware": [
    1,
    2,
    3
  ],
  "q_used": [
    1
  ],
  "q_trusted": [
    1,
    2
  ],
  "q_fav_brand": 1,
  "q_years_used": {
    "1": 10
  },
  "q_detail_interest": 1,
  "q_n_products": 1
}
```

Expected:

- LOOP_001 runs once
- LISTFILL_BRAND_EVAL_COUNT = 1
- q_lf_sat_2 hidden

Predicted route (64 pages, end status **complete**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates` → `p_quota_cell` → `p_tech_usage` → `p_tech_priorities` → `p_tech_spend` → `p_tech_spend_12m` → `p_tech_sat` → `p_combined` → `p_brand_unaided` → `p_brand_aware` → `p_brand_used` → `p_brand_fav` → `p_brand_grids` → `p_brand_grids_2` → `p_brand_detail_gate` → `p_lf_eval` → `p_lf_loop@1` → `p_listops_1` → `p_listops_2` → `p_listops_3` → `p_l1_a@1` → `p_l1_b@1` → `p_l1_c@1` → `p_l2@1@battery` → `p_l2@1@camera` → `p_l2@1@price` → `p_l3@2` → `p_l3@3` → `p_l4@9` → `p_l4@12` → `p_l6_count` → `p_l6@1` → `p_rand_1` → `p_rand_2` → `p_rand_3` → `p_rand_experiment` → `p_att_sustain` → `p_att_ai` → `p_calc_summary` → `p_calc_segments` → `p_val_1` → `p_val_2` → `p_cbc` → `p_cbc_follow` → `p_maxdiff` → `p_maxdiff_follow` → `p_cd@1` → `p_cd@2` → `p_cd@3` → `p_spec_grid` → `p_spec_repeat` → `p_spec_media` → `p_spec_variants` → `p_oe_1` → `p_oe_2` → `p_final`

List Fill results: lf_topic: innovation · lf_brand_eval: Apple · lf_trust: Apple

## Path C — Five or more brands

Seven brands used → LOOP_001 capped at 6 by the LOOP_CAP calculation; every list operation has a non-empty result.

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2,
  "q_aware": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    10,
    11,
    12
  ],
  "q_used": [
    1,
    2,
    3,
    4,
    5,
    6,
    7
  ],
  "q_trusted": [
    1,
    2,
    7
  ],
  "q_fav_brand": 2,
  "q_years_used": {
    "1": 3,
    "2": 5,
    "3": 1,
    "4": 2,
    "5": 1,
    "6": 12,
    "7": 15
  },
  "q_detail_interest": 1,
  "q_n_products": 5
}
```

Expected:

- LOOP_001 runs 6 times (cap)
- LOOP_006 runs 5 times
- curious/consider/core/never-seen lists all non-empty

Predicted route (100 pages, end status **complete**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates` → `p_quota_cell` → `p_tech_usage` → `p_tech_priorities` → `p_tech_spend` → `p_tech_spend_12m` → `p_tech_sat` → `p_combined` → `p_brand_unaided` → `p_brand_aware` → `p_brand_used` → `p_brand_fav` → `p_brand_grids` → `p_brand_grids_2` → `p_brand_detail_gate` → `p_lf_eval` → `p_lf_loop@1` → `p_lf_loop@2` → `p_listops_1` → `p_listops_2` → `p_listops_3` → `p_l1_a@1` → `p_l1_b@1` → `p_l1_c@1` → `p_l2@1@battery` → `p_l2@1@camera` → `p_l2@1@price` → `p_l1_a@2` → `p_l1_b@2` → `p_l1_c@2` → `p_l2@2@battery` → `p_l2@2@camera` → `p_l2@2@price` → `p_l1_a@3` → `p_l1_b@3` → `p_l1_c@3` → `p_l2@3@battery` → `p_l2@3@camera` → `p_l2@3@price` → `p_l1_a@4` → `p_l1_b@4` → `p_l1_c@4` → `p_l2@4@battery` → `p_l2@4@camera` → `p_l2@4@price` → `p_l1_a@5` → `p_l1_b@5` → `p_l1_c@5` → `p_l2@5@battery` → `p_l2@5@camera` → `p_l2@5@price` → `p_l1_a@6` → `p_l1_b@6` → `p_l1_c@6` → `p_l2@6@battery` → `p_l2@6@camera` → `p_l2@6@price` → `p_l3@10` → `p_l3@11` → `p_l3@12` → `p_l4@9` → `p_l4@12` → `p_l6_count` → `p_l6@1` → `p_l6@2` → `p_l6@3` → `p_l6@4` → `p_l6@5` → `p_rand_1` → `p_rand_2` → `p_rand_3` → `p_rand_experiment` → `p_att_ai` → `p_att_sustain` → `p_calc_summary` → `p_calc_segments` → `p_val_1` → `p_val_2` → `p_cbc` → `p_cbc_follow` → `p_maxdiff` → `p_maxdiff_follow` → `p_cd@1` → `p_cd@2` → `p_cd@3` → `p_spec_grid` → `p_spec_repeat` → `p_spec_media` → `p_spec_variants` → `p_oe_1` → `p_oe_2` → `p_final`

List Fill results: lf_topic: pricing · lf_brand_eval: Apple, Samsung · lf_trust: Microsoft

## Path D — Fails screening

Declines consent → terminated as 'screened' on the first page; nothing else is asked.

Key answers:

```json
{
  "q_consent": 2
}
```

Expected:

- status screened after page 1

Predicted route (1 pages, end status **screened**):

`p_intro_welcome`

List Fill results: lf_topic: privacy

## Path E — Quota full

Female 25–34 when that combined cell (and the gender cell) is already full → quota_check terminates with status 'quota_full'.

Precondition: the female / 25–34 cells are already full (in Test Mode: set the quota counts, or run enough test completes).

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2
}
```

Expected:

- status quota_full at the quota_check node

Predicted route (9 pages, end status **quota_full**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates`

List Fill results: lf_topic: innovation

## Path F — List Fill cap reached

Apple used, but Apple has already hit its maximum of 150 → the engine moves down the priority order (Samsung), demonstrating cap + fallback.

Precondition: Apple has already been allocated 150 times in LF_BRAND_EVAL.

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2,
  "q_aware": [
    1,
    2,
    3
  ],
  "q_used": [
    1,
    2,
    3
  ],
  "q_trusted": [
    1,
    2
  ],
  "q_fav_brand": 1,
  "q_years_used": {
    "1": 1,
    "2": 1,
    "3": 1
  },
  "q_detail_interest": 1,
  "q_n_products": 1
}
```

Expected:

- Apple rejected (maximum_reached)
- Samsung allocated at position 1

Predicted route (75 pages, end status **complete**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates` → `p_quota_cell` → `p_tech_usage` → `p_tech_priorities` → `p_tech_spend` → `p_tech_spend_12m` → `p_tech_sat` → `p_combined` → `p_brand_unaided` → `p_brand_aware` → `p_brand_used` → `p_brand_fav` → `p_brand_grids` → `p_brand_grids_2` → `p_brand_detail_gate` → `p_lf_eval` → `p_lf_loop@2` → `p_lf_loop@3` → `p_listops_1` → `p_listops_2` → `p_listops_3` → `p_l1_a@1` → `p_l1_b@1` → `p_l1_c@1` → `p_l2@1@battery` → `p_l2@1@camera` → `p_l2@1@price` → `p_l1_a@2` → `p_l1_b@2` → `p_l1_c@2` → `p_l2@2@battery` → `p_l2@2@camera` → `p_l2@2@price` → `p_l1_a@3` → `p_l1_b@3` → `p_l1_c@3` → `p_l2@3@battery` → `p_l2@3@camera` → `p_l2@3@price` → `p_l4@9` → `p_l4@12` → `p_l6_count` → `p_l6@1` → `p_rand_1` → `p_rand_2` → `p_rand_3` → `p_rand_experiment` → `p_att_ai` → `p_att_privacy` → `p_calc_summary` → `p_calc_segments` → `p_val_1` → `p_val_2` → `p_cbc` → `p_cbc_follow` → `p_maxdiff` → `p_maxdiff_follow` → `p_cd@1` → `p_cd@2` → `p_cd@3` → `p_spec_grid` → `p_spec_repeat` → `p_spec_media` → `p_spec_variants` → `p_oe_1` → `p_oe_2` → `p_final`

List Fill results: lf_topic: customer service · lf_brand_eval: Samsung, Google · lf_trust: Samsung

## Path G — Multiple loop iterations + invalid years

Four brands used, one with an implausible years-used entry → LOOP_001 ×4, LOOP_005 ×1 (script-detected invalid item), N_PRODUCTS = 3 → LOOP_006 ×3.

Key answers:

```json
{
  "q_consent": 1,
  "q_age": 29,
  "q_employment": 1,
  "q_use_type": 3,
  "q_gender": 2,
  "q_aware": [
    1,
    2,
    3,
    4,
    5,
    6
  ],
  "q_used": [
    1,
    2,
    3,
    4
  ],
  "q_trusted": [
    1,
    2
  ],
  "q_fav_brand": 3,
  "q_years_used": {
    "1": 5,
    "2": 40,
    "3": 3,
    "4": 1
  },
  "q_detail_interest": 1,
  "q_n_products": 3
}
```

Expected:

- LOOP_001 runs 4 times
- LOOP_005 runs once for Samsung (40 years > age 29)
- LOOP_006 runs 3 times

Predicted route (86 pages, end status **complete**):

`p_intro_welcome` → `p_intro_about` → `p_intro_contact` → `p_screen_1` → `p_screen_2` → `p_demo_core` → `p_demo_work` → `p_demo_household` → `p_demo_dates` → `p_quota_cell` → `p_tech_usage` → `p_tech_priorities` → `p_tech_spend` → `p_tech_spend_12m` → `p_tech_sat` → `p_combined` → `p_brand_unaided` → `p_brand_aware` → `p_brand_used` → `p_brand_fav` → `p_brand_grids` → `p_brand_grids_2` → `p_brand_detail_gate` → `p_lf_eval` → `p_lf_loop@1` → `p_lf_loop@2` → `p_listops_1` → `p_listops_2` → `p_listops_3` → `p_l1_a@1` → `p_l1_b@1` → `p_l1_c@1` → `p_l2@1@battery` → `p_l2@1@camera` → `p_l2@1@price` → `p_l1_a@2` → `p_l1_b@2` → `p_l1_c@2` → `p_l2@2@battery` → `p_l2@2@camera` → `p_l2@2@price` → `p_l1_a@3` → `p_l1_b@3` → `p_l1_c@3` → `p_l2@3@battery` → `p_l2@3@camera` → `p_l2@3@price` → `p_l1_a@4` → `p_l1_b@4` → `p_l1_c@4` → `p_l2@4@battery` → `p_l2@4@camera` → `p_l2@4@price` → `p_l3@6` → `p_l3@5` → `p_l4@9` → `p_l4@12` → `p_l5@2` → `p_l6_count` → `p_l6@1` → `p_l6@2` → `p_l6@3` → `p_rand_1` → `p_rand_2` → `p_rand_3` → `p_rand_experiment` → `p_att_sustain` → `p_att_ai` → `p_calc_summary` → `p_calc_segments` → `p_val_1` → `p_val_2` → `p_cbc` → `p_cbc_follow` → `p_maxdiff` → `p_maxdiff_follow` → `p_cd@1` → `p_cd@2` → `p_cd@3` → `p_spec_grid` → `p_spec_repeat` → `p_spec_media` → `p_spec_variants` → `p_oe_1` → `p_oe_2` → `p_final`

List Fill results: lf_topic: repairability · lf_brand_eval: Apple, Samsung · lf_trust: Apple

