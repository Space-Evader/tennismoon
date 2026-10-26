import copy
import unittest
from watchdog import assess

NOW='2026-10-26T18:00:00-04:00'; DEADLINE='2026-10-26T17:00:00-04:00'; DAY='2026-10-26'
GOOD={'conclusion':'success','staging_step':'success','staging_receipt':{'id':'synthetic-receipt','acknowledged_at':'2026-10-26T16:30:00-04:00','published':False,'owner_approved':False}}
class WatchdogTests(unittest.TestCase):
    def check(self,runs): return assess(NOW,DEADLINE,runs,DAY)
    def test_success_needs_an_actual_acknowledgement(self):
        self.assertFalse(self.check([GOOD])['alert'])
        self.assertEqual(self.check([{'conclusion':'success','staging_step':'success'}])['state'],'incomplete')
    def test_skipped_run_missing_run_and_failure_alert(self):
        for runs,state in [([], 'missed'),([{'conclusion':'skipped'}],'skipped'),([{'conclusion':'failure'}],'failed'),([{'conclusion':'success','staging_step':'skipped'}],'skipped')]:
            self.assertEqual(self.check(runs)['state'],state);self.assertTrue(self.check(runs)['alert'])
    def test_before_deadline_does_not_alarm(self):
        self.assertEqual(assess('2026-10-26T16:00:00-04:00',DEADLINE,[],DAY)['state'],'not_due')
    def test_old_future_or_publication_receipts_are_not_a_daily_success(self):
        for field,value in [('acknowledged_at','2026-10-25T16:30:00-04:00'),('acknowledged_at','2026-10-27T16:30:00-04:00'),('published',True),('owner_approved',True)]:
            r=copy.deepcopy(GOOD);r['staging_receipt'][field]=value;self.assertTrue(self.check([r])['alert'])
    def test_alert_identity_stays_stable_and_recovery_clears_alarm(self):
        a=self.check([]);b=self.check([{'conclusion':'failure'}]);self.assertEqual(a['key'],b['key']);self.assertFalse(self.check([GOOD])['alert'])
if __name__=='__main__':unittest.main()
