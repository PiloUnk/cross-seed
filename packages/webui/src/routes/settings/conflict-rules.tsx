import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { Page } from '@/components/Page';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Trash, X } from 'lucide-react';
import { toast } from 'sonner';

export const Route = createFileRoute('/settings/conflict-rules')({
  component: ConflictRulesSettings,
});

type PriorityRule = {
  id: string;
  trackers: string[];
  mode: 'trackers' | 'allIndexers';
};

type StoredRule = {
  id: number;
  priority: number;
  allIndexers: boolean;
  trackers: string[];
};

type DisplayRule = PriorityRule & {
  locked: boolean;
};

type TrackerOptions = {
  trackers: string[];
};

type SavedRulesResponse = {
  rules: StoredRule[];
};

type SaveRulesInput = {
  rules: { allIndexers: boolean; trackers: string[] }[];
};

type SaveRulesResponse = {
  success: boolean;
};

const createRule = (trackers: string[] = []): PriorityRule => {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, trackers, mode: 'trackers' };
};

const normalizeTrackerList = (trackers: string[]) =>
  Array.from(new Set(trackers)).sort();

const sanitizeTrackerLabel = (value: string) =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code !== 127) || code > 127;
    })
    .join('')
    .replace(/[<>"'`]/g, '')
    .trim();

const normalizeRuleList = (rules: PriorityRule[]) =>
  rules.map((rule) => ({
    allIndexers: rule.mode === 'allIndexers',
    trackers:
      rule.mode === 'allIndexers' ? [] : normalizeTrackerList(rule.trackers),
  }));

const normalizeStoredRuleList = (rules: StoredRule[]) =>
  rules.map((rule) => ({
    allIndexers: rule.allIndexers,
    trackers: rule.allIndexers ? [] : normalizeTrackerList(rule.trackers),
  }));

const buildRulesToSave = (rules: PriorityRule[]) => {
  const normalizedRules = normalizeRuleList(rules);
  if (!rules.length) return normalizedRules;
  if (rules[0]?.mode === 'allIndexers') {
    return [{ allIndexers: true, trackers: [] }];
  }
  return [...normalizedRules, { allIndexers: true, trackers: [] }];
};

function ConflictRulesSettings() {
  const trpc = useTRPC();
  const [includePublicTrackers, setIncludePublicTrackers] = useState(false);
  const [priorityRules, setPriorityRules] = useState<PriorityRule[]>([]);
  const [selectorValues, setSelectorValues] = useState<Record<string, string>>(
    {},
  );
  const lastSavedRulesRef = useRef<string>('[]');
  const hasInitializedRef = useRef(false);

  const { data: trackerOptions } = useSuspenseQuery(
    trpc.conflictRules.getTrackerOptions.queryOptions(),
  ) as { data: TrackerOptions };

  const { mutate: saveRules } = useMutation<
    SaveRulesResponse,
    unknown,
    SaveRulesInput
  >(trpc.conflictRules.saveRules.mutationOptions());

  const { data: savedRulesData } = useSuspenseQuery(
    trpc.conflictRules.getRules.queryOptions(),
  ) as { data: SavedRulesResponse };

  const { data: thirdPartyTrackerOptions } = useQuery(
    trpc.conflictRules.getThirdPartyTrackers.queryOptions({
      includePublic: includePublicTrackers,
    }),
  ) as { data?: TrackerOptions };

  const indexerTrackers = useMemo(
    () => trackerOptions.trackers ?? [],
    [trackerOptions.trackers],
  );
  const thirdPartyTrackers = useMemo(
    () => thirdPartyTrackerOptions?.trackers ?? [],
    [thirdPartyTrackerOptions?.trackers],
  );
  const combinedTrackers = useMemo(() => {
    const trackers = new Set(indexerTrackers);
    for (const tracker of thirdPartyTrackers) {
      trackers.add(tracker);
    }
    return Array.from(trackers).sort();
  }, [indexerTrackers, thirdPartyTrackers]);

  const displayRules = useMemo<DisplayRule[]>(() => {
    if (!priorityRules.length) return [];
    if (priorityRules[0]?.mode === 'allIndexers') {
      return priorityRules.map((rule) => ({
        ...rule,
        locked: false,
      }));
    }
    return [
      ...priorityRules.map((rule) => ({
        ...rule,
        locked: false,
      })),
      {
        id: 'all-indexers',
        trackers: [],
        mode: 'allIndexers',
        locked: true,
      },
    ];
  }, [priorityRules]);

  const getAvailableTrackers = (
    currentRuleId: string,
    currentTrackers: string[],
  ) => {
    const usedTrackers = new Set<string>();
    for (const rule of priorityRules) {
      if (rule.id === currentRuleId) continue;
      for (const tracker of rule.trackers) {
        usedTrackers.add(tracker);
      }
    }
    return combinedTrackers
      .filter((tracker) => !usedTrackers.has(tracker))
      .filter((tracker) => !currentTrackers.includes(tracker));
  };

  const handleAddRule = () => {
    setPriorityRules((prev) => [...prev, createRule()]);
  };

  const handleRemoveRule = (id: string) => {
    setPriorityRules((prev) => {
      const next = prev.filter((rule) => rule.id !== id);
      if (next[0]?.mode === 'allIndexers' && next.length > 1) {
        return [next[0]];
      }
      return next;
    });
    setSelectorValues((prev) => {
      const { [id]: removedValue, ...rest } = prev;
      void removedValue;
      return rest;
    });
  };

  const handleAddTracker = (id: string, tracker: string, ruleIndex: number) => {
    if (tracker === '__all_indexers__' && ruleIndex === 0) {
      setPriorityRules((prev) => {
        const rule = prev.find((item) => item.id === id);
        if (!rule) return prev;
        return [
          {
            ...rule,
            trackers: [],
            mode: 'allIndexers',
          },
        ];
      });
      setSelectorValues({ [id]: '' });
      return;
    }
    setPriorityRules((prev) =>
      prev.map((rule) => {
        if (rule.id !== id) return rule;
        if (rule.trackers.includes(tracker)) return rule;
        return { ...rule, trackers: [...rule.trackers, tracker] };
      }),
    );
    setSelectorValues((prev) => ({ ...prev, [id]: '' }));
  };

  const handleRemoveTracker = (id: string, tracker: string) => {
    setPriorityRules((prev) =>
      prev.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              trackers: rule.trackers.filter((item) => item !== tracker),
            }
          : rule,
      ),
    );
  };

  const savedRules = useMemo(
    () => savedRulesData?.rules ?? [],
    [savedRulesData?.rules],
  );
  const serializedCurrentRules = useMemo(
    () => JSON.stringify(buildRulesToSave(priorityRules)),
    [priorityRules],
  );
  const isDirty = lastSavedRulesRef.current !== serializedCurrentRules;

  useEffect(() => {
    if (hasInitializedRef.current) return;
    const nonAllIndexerRules = savedRules.filter((rule) => !rule.allIndexers);
    const initialRules = nonAllIndexerRules.length
      ? nonAllIndexerRules.map((rule) => ({
          id: String(rule.id),
          trackers: normalizeTrackerList(rule.trackers),
          mode: 'trackers' as const,
        }))
      : savedRules.some((rule) => rule.allIndexers)
        ? [
            {
              id: 'all-indexers-primary',
              trackers: [],
              mode: 'allIndexers' as const,
            },
          ]
        : [];
    setPriorityRules(initialRules);
    lastSavedRulesRef.current = JSON.stringify(
      normalizeStoredRuleList(savedRules),
    );
    hasInitializedRef.current = true;
  }, [savedRules]);

  const handleSaveRules = () => {
    const hasEmptyRule = priorityRules.some(
      (rule) => rule.mode === 'trackers' && rule.trackers.length === 0,
    );
    if (hasEmptyRule) {
      toast.error('Cannot save empty rule');
      return;
    }
    const rulesToSave = buildRulesToSave(priorityRules);
    saveRules(
      { rules: rulesToSave },
      {
        onSuccess: () => {
          lastSavedRulesRef.current = JSON.stringify(rulesToSave);
        },
      },
    );
  };

  return (
    <Page breadcrumbs={['Settings', 'Conflict Rules']}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Conflict Rules</h1>
          <p className="text-muted-foreground text-sm">
            Trackers closer to level 1 take priority over lower levels. If a
            torrent conflicts with an info hash collision, the most prioritized
            tracker keeps the seed over less prioritized trackers. When no rules
            exist, collisions are only reported for manual handling in your
            torrent client.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Tracker Sources</CardTitle>
            <CardDescription>
              Trackers are split between indexers and third-party sources from
              your torrent clients.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium">
                  Show third-party public trackers
                </Label>
                <Switch
                  checked={includePublicTrackers}
                  onCheckedChange={setIncludePublicTrackers}
                />
              </div>
              <Badge variant="outline" className="px-2">
                {combinedTrackers.length} trackers available
              </Badge>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Indexer trackers</span>
                  <Badge variant="outline" className="px-2">
                    {indexerTrackers.length}
                  </Badge>
                </div>
                <ScrollArea className="h-24 rounded-md border p-3">
                  <div className="flex flex-wrap gap-2">
                    {indexerTrackers.length === 0 ? (
                      <span className="text-muted-foreground text-sm">
                        No indexer trackers available yet.
                      </span>
                    ) : (
                      indexerTrackers.map((tracker) => (
                        <Badge key={tracker} variant="secondary">
                          {sanitizeTrackerLabel(tracker)}
                        </Badge>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Third-party trackers
                  </span>
                  <Badge variant="outline" className="px-2">
                    {thirdPartyTrackers.length}
                  </Badge>
                </div>
                <ScrollArea className="h-24 rounded-md border p-3">
                  <div className="flex flex-wrap gap-2">
                    {thirdPartyTrackers.length === 0 ? (
                      <span className="text-muted-foreground text-sm">
                        No third-party trackers available yet.
                      </span>
                    ) : (
                      thirdPartyTrackers.map((tracker) => (
                        <Badge key={tracker} variant="secondary">
                          {sanitizeTrackerLabel(tracker)}
                        </Badge>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Priority Levels</CardTitle>
            <CardDescription>
              Each level can include multiple trackers. A final rule matching
              all indexer trackers is added automatically after the first rule.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Priority</TableHead>
                  <TableHead>Trackers</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {priorityRules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <span className="text-muted-foreground text-sm">
                        No priority levels yet.
                      </span>
                    </TableCell>
                  </TableRow>
                ) : (
                  displayRules.map((rule, index) => (
                    <TableRow key={rule.id}>
                      <TableCell className="font-medium">
                        Level {index + 1}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-3">
                          {rule.locked ? (
                            <Badge variant="secondary" className="opacity-70">
                              All indexer trackers
                            </Badge>
                          ) : rule.mode === 'allIndexers' ? (
                            <Badge variant="secondary">
                              All indexer trackers
                            </Badge>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              {(() => {
                                const availableTrackers = getAvailableTrackers(
                                  rule.id,
                                  rule.trackers,
                                );
                                return (
                                  <>
                                    {rule.trackers.length === 0 ? (
                                      <span className="text-muted-foreground text-sm">
                                        No trackers selected.
                                      </span>
                                    ) : (
                                      rule.trackers.map((tracker) => (
                                        <Badge
                                          key={`${rule.id}-${tracker}`}
                                          variant="secondary"
                                          className="flex items-center gap-1 pr-1"
                                        >
                                          {sanitizeTrackerLabel(tracker)}
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-4 w-4 p-0"
                                            onClick={() =>
                                              handleRemoveTracker(
                                                rule.id,
                                                tracker,
                                              )
                                            }
                                            aria-label={`Remove ${tracker}`}
                                          >
                                            <X className="size-3" />
                                          </Button>
                                        </Badge>
                                      ))
                                    )}
                                    <Select
                                      value={selectorValues[rule.id] ?? ''}
                                      onValueChange={(value) =>
                                        handleAddTracker(rule.id, value, index)
                                      }
                                    >
                                      <SelectTrigger className="min-w-[220px]">
                                        <SelectValue placeholder="Add tracker" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {index === 0 && (
                                          <SelectItem value="__all_indexers__">
                                            All indexer trackers
                                          </SelectItem>
                                        )}
                                        {availableTrackers.map((tracker) => (
                                          <SelectItem
                                            key={tracker}
                                            value={tracker}
                                          >
                                            {sanitizeTrackerLabel(tracker)}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {!rule.locked && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveRule(rule.id)}
                            aria-label="Remove priority level"
                          >
                            <Trash className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter>
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                onClick={handleAddRule}
                disabled={priorityRules[0]?.mode === 'allIndexers'}
              >
                <Plus className="mr-2 size-4" />
                Add priority level
              </Button>
              <Button onClick={handleSaveRules} disabled={!isDirty}>
                Save rules
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </Page>
  );
}
